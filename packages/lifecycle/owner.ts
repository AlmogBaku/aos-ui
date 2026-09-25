import {
  assign,
  createActor,
  setup,
  type Actor,
  type AnyActorRef,
  type AnyEventObject,
  type AnyStateMachine,
  type InspectionEvent,
  type Observer,
} from "xstate"

import type { Clock } from "./clock"
import type { LogFields, Logger } from "./logger"

export type OwnerKind =
  "connection" | "membership" | "turn" | "link" | "reading" | "session-owner"

/** `bumpGeneration` moves the generation that `stale` compares against. */
export type OwnerContext = { generation: number }

type TransitionParams = { to: string; after: string[]; info: boolean }

type Track = { log: Logger; state?: string; since?: number; armedMs?: number }

/** Where each actor last was; createOwner seeds its logger. */
const tracks = new WeakMap<AnyActorRef, Track>()

type DelayMap = Record<
  string,
  number | ((args: unknown, params: undefined) => number)
>

/** The earliest `after` deadline a state arms, resolved as XState does. */
function armedMs(self: AnyActorRef, keys: string[], args: unknown) {
  if (keys.length === 0) return undefined
  const { delays } = (self as unknown as { logic: AnyStateMachine }).logic
    .implementations as { delays: DelayMap }
  return Math.min(
    ...keys.map((key) => {
      const delay = Number.isNaN(Number(key)) ? delays[key]! : Number(key)
      return typeof delay === "function" ? delay(args, undefined) : delay
    })
  )
}

type StateConfig = {
  id?: string
  type?: string
  states?: Record<string, StateConfig>
  entry?: unknown
  after?: Record<string, unknown>
  meta?: { log?: string }
}

/** Append `logTransition` to the entry of every atomic and final state. */
function withTransitionLog(node: StateConfig, path: string[]): StateConfig {
  if (node.type === "history") return node
  if (node.states && Object.keys(node.states).length > 0)
    return {
      ...node,
      states: Object.fromEntries(
        Object.entries(node.states).map(([key, child]) => [
          key,
          withTransitionLog(child, [...path, key]),
        ])
      ),
    }
  const params: TransitionParams = {
    to: path.join("."),
    after: Object.keys(node.after ?? {}),
    info: node.meta?.log === "info",
  }
  const entry = node.entry === undefined ? [] : [node.entry].flat()
  return { ...node, entry: [...entry, { type: "logTransition", params }] }
}

type Instrumentable = {
  createMachine(config: never): unknown
  extend(implementations: never): Instrumentable
}

function instrumented<TSetup extends Instrumentable>(
  kind: OwnerKind,
  base: TSetup
): TSetup {
  return {
    ...base,
    createMachine: (config: StateConfig) =>
      base.createMachine(
        withTransitionLog({ id: kind, ...config }, []) as never
      ),
    extend: (implementations: never) =>
      instrumented(kind, base.extend(implementations)),
  }
}

/**
 * XState `setup()` for one owner kind. Context holds ids and credential
 * sources, never credential values or message text. Every state entered
 * writes one `${kind}.transition` line at debug (from, to, generation, and
 * the deadline it arms or clears), or `${kind}.${state}` at info when its
 * meta is `{ log: "info" }`. The machine id defaults to the kind.
 */
export function ownerSetup<
  TContext extends OwnerContext = OwnerContext,
  TEvent extends AnyEventObject = AnyEventObject,
>(kind: OwnerKind, logger: Logger, clock: Clock) {
  return instrumented(
    kind,
    setup({
      types: {} as { context: TContext; events: TEvent },
      actions: {
        logTransition: (args, { to, after, info }: TransitionParams) => {
          const { context, event, self } = args
          const track = tracks.get(self) ?? { log: logger }
          tracks.set(self, track)
          const now = clock.now()
          const armed = armedMs(self, after, args)
          if (track.state !== undefined) {
            const cleared =
              track.armedMs !== undefined &&
              !event.type.startsWith("xstate.after.")
            track.log[info ? "info" : "debug"](
              {
                from: track.state,
                to,
                generation: context.generation,
                event: event.type,
                elapsedMs: now - track.since!,
                ...(armed !== undefined && { armedMs: armed }),
                ...(cleared && { clearedMs: track.armedMs }),
              },
              info ? `${kind}.${to}` : `${kind}.transition`
            )
          }
          Object.assign(track, { state: to, since: now, armedMs: armed })
        },
        bumpGeneration: assign(
          ({ context }) =>
            ({ generation: context.generation + 1 }) as Partial<TContext>
        ),
      },
    })
  )
}

export type OwnerOptions = {
  logger: Logger
  clock: Clock
  inspect?: Observer<InspectionEvent> | ((event: InspectionEvent) => void)
  bindings: LogFields
}

export type Owner<TMachine extends AnyStateMachine> = {
  actor: Actor<TMachine>
  readonly generation: number
  stack: DisposableStack
  stale(generation: number): boolean
  dispose(): void
}

/** Start one owner actor on the injected clock, logging with `bindings`. */
export function createOwner<TMachine extends AnyStateMachine>(
  machine: TMachine,
  { logger, clock, inspect, bindings }: OwnerOptions
): Owner<TMachine> {
  const log = logger.child(bindings)
  const actor = createActor(machine as AnyStateMachine, {
    clock,
    inspect,
  }) as Actor<TMachine>
  tracks.set(actor, { log })
  const stack = new DisposableStack()
  const generation = () =>
    (actor.getSnapshot() as { context: OwnerContext }).context.generation
  actor.start()
  return {
    actor,
    stack,
    get generation() {
      return generation()
    },
    stale: (candidate) => candidate !== generation(),
    dispose: () => actor.stop(),
  }
}
