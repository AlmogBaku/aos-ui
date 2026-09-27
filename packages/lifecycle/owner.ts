import {
  assign,
  createActor,
  fromPromise,
  setup,
  type Actor,
  type AnyActorRef,
  type AnyEventObject,
  type AnyStateMachine,
  type InspectionEvent,
  type NonReducibleUnknown,
  type Observer,
  type UnknownActorLogic,
} from "xstate"

import type { Clock } from "./clock"
import type { LogFields, Logger } from "./logger"

export type OwnerKind =
  "connection" | "membership" | "turn" | "link" | "reading" | "session-owner"

/** `bumpGeneration` moves the generation that `stale` compares against. */
export type OwnerContext = { generation: number }

type TransitionParams = { to: string; info: boolean }

/** A state's `after` keys, each with the event XState raises when it fires. */
type AfterParams = { after: { key: string; event: string }[] }

type ActorMap = Record<string, UnknownActorLogic>

/** The actions ownerSetup provides, with their params. */
type OwnerActions = {
  armAfter: AfterParams
  clearAfter: AfterParams
  logTransition: TransitionParams
  bumpGeneration: undefined
}

/** A deadline as logged: a static delay in ms, or a function delay's key. */
type Armed = number | string

type Track = {
  log: Logger
  state?: string
  since?: number
  /** Deadlines armed and cleared since the last transition line. */
  armed: Armed[]
  cleared: Armed[]
}

/** Where each actor last was; createOwner seeds its logger. */
const tracks = new WeakMap<AnyActorRef, Track>()

const newTrack = (log: Logger): Track => ({ log, armed: [], cleared: [] })

/**
 * Only XState calls a function delay, so a jittered deadline is drawn once,
 * for the timer that fires; the log names its key instead.
 */
function armedAs(self: AnyActorRef, key: string): Armed {
  if (!Number.isNaN(Number(key))) return Number(key)
  const { delays } = (self as unknown as { logic: AnyStateMachine }).logic
    .implementations as { delays: Record<string, unknown> }
  const delay = delays[key]
  return typeof delay === "number" ? delay : key
}

type StateConfig = {
  id?: string
  type?: string
  states?: Record<string, StateConfig>
  entry?: unknown
  exit?: unknown
  after?: Record<string, unknown>
  meta?: { log?: string }
}

const actionList = (actions: unknown) =>
  actions === undefined ? [] : [actions].flat()

/**
 * Every state with `after` records the deadlines it arms on entry and clears
 * on exit, and every atomic or final state writes the line on entry.
 */
function withTransitionLog(
  node: StateConfig,
  path: string[],
  machineId: string
): StateConfig {
  if (node.type === "history") return node
  const id = node.id ?? [machineId, ...path].join(".")
  const after = Object.keys(node.after ?? {}).map((key) => ({
    key,
    event: `xstate.after.${Number.isNaN(Number(key)) ? key : Number(key)}.${id}`,
  }))
  const entry = actionList(node.entry)
  const exit = actionList(node.exit)
  if (after.length > 0) {
    entry.push({ type: "armAfter", params: { after } })
    exit.push({ type: "clearAfter", params: { after } })
  }
  const children = Object.entries(node.states ?? {})
  if (children.length === 0) {
    const params: TransitionParams = {
      to: path.join("."),
      info: node.meta?.log === "info",
    }
    entry.push({ type: "logTransition", params })
  }
  return {
    ...node,
    entry,
    exit,
    ...(children.length > 0 && {
      states: Object.fromEntries(
        children.map(([key, child]) => [
          key,
          withTransitionLog(child, [...path, key], machineId),
        ])
      ),
    }),
  }
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
    createMachine: (config: StateConfig) => {
      const root = { id: kind, ...config }
      return base.createMachine(withTransitionLog(root, [], root.id) as never)
    },
    extend: (implementations: never) =>
      instrumented(kind, base.extend(implementations)),
  }
}

/**
 * XState `setup()` for one owner kind. Context holds ids and credential
 * sources, never credential values or message text. Every atomic or final
 * state entered writes one `${kind}.transition` line at debug (from, to,
 * generation, and the `after` deadlines armed and cleared on the way, in ms
 * or by key for a function delay), or `${kind}.${state}` at info when its
 * meta is `{ log: "info" }`. The machine id defaults to the kind. Parallel
 * states are not tracked: `from` and `to` assume one active state. Declared
 * `actors` type every invoke by name, provided a caller that names the
 * context and event types names `typeof actors` too; without them any inline
 * source type-checks.
 */
export function ownerSetup<
  TContext extends OwnerContext = OwnerContext,
  TEvent extends AnyEventObject = AnyEventObject,
  TActors extends ActorMap = ActorMap,
>(kind: OwnerKind, logger: Logger, clock: Clock, actors?: TActors) {
  const trackOf = (self: AnyActorRef) => {
    const track = tracks.get(self) ?? newTrack(logger)
    tracks.set(self, track)
    return track
  }
  return instrumented(
    kind,
    // XState cannot infer a generic actor map, so its type arguments are
    // named; the open default map is what lets it type an inline source.
    setup<TContext, TEvent, TActors, Record<never, string>, OwnerActions>({
      types: {} as { context: TContext; events: TEvent },
      actors: (actors ?? {}) as never,
      actions: {
        armAfter: ({ self }, { after }: AfterParams) => {
          trackOf(self).armed.push(
            ...after.map(({ key }) => armedAs(self, key))
          )
        },
        clearAfter: ({ event, self }, { after }: AfterParams) => {
          const unfired = after.filter((timer) => timer.event !== event.type)
          trackOf(self).cleared.push(
            ...unfired.map(({ key }) => armedAs(self, key))
          )
        },
        logTransition: (
          { context, event, self },
          { to, info }: TransitionParams
        ) => {
          const track = trackOf(self)
          const { armed, cleared } = track
          const now = clock.now()
          if (track.state !== undefined)
            track.log[info ? "info" : "debug"](
              {
                from: track.state,
                to,
                generation: context.generation,
                event: event.type,
                elapsedMs: now - track.since!,
                ...(armed.length > 0 && { armed }),
                ...(cleared.length > 0 && { cleared }),
              },
              info ? `${kind}.${to}` : `${kind}.transition`
            )
          Object.assign(track, {
            state: to,
            since: now,
            armed: [],
            cleared: [],
          })
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
  /** True for a result from an earlier generation or a released owner. */
  stale(generation: number): boolean
  /** Stop the actor; its stack releases once the stop is processed. */
  dispose(): void
}

/** An invoke source whose signal aborts when the invoking state exits. */
export function fromAbortable<TOutput, TInput = NonReducibleUnknown>(
  fn: (signal: AbortSignal, input: TInput) => PromiseLike<TOutput>
) {
  return fromPromise<TOutput, TInput>(({ signal, input }) => fn(signal, input))
}

/**
 * XState 5.33 stops a parent's children when it stops or finishes, but not
 * when one of its actions throws; its `_stop` is the only way to do it then.
 */
function stopChildren(actor: AnyActorRef) {
  const { children } = actor.getSnapshot() as {
    children: Record<string, AnyActorRef | undefined>
  }
  for (const child of Object.values(children))
    (child as unknown as { _stop?: () => void } | undefined)?._stop?.()
}

/**
 * Start one owner actor on the injected clock, logging with `bindings`. Its
 * stack is disposed exactly once, after its children stop, whether the owner
 * is disposed, reaches a final state or fails. XState only queues a stop
 * sent from the actor's own processing, so the release waits on `complete`.
 */
export function createOwner<TMachine extends AnyStateMachine>(
  machine: TMachine,
  { logger, clock, inspect, bindings }: OwnerOptions
): Owner<TMachine> {
  const log = logger.child(bindings)
  const actor = createActor(machine as AnyStateMachine, {
    clock,
    inspect,
  }) as Actor<TMachine>
  tracks.set(actor, newTrack(log))
  const stack = new DisposableStack()
  const release = () => {
    try {
      stack.dispose()
    } catch (err) {
      log.error({ err }, `${machine.id}.failed`)
    }
  }
  actor.subscribe({
    complete: release,
    error: (err) => {
      log.error({ err }, `${machine.id}.failed`)
      stopChildren(actor)
      release()
    },
  })
  const generation = () =>
    (actor.getSnapshot() as { context: OwnerContext }).context.generation
  actor.start()
  return {
    actor,
    stack,
    get generation() {
      return generation()
    },
    stale: (candidate) => stack.disposed || candidate !== generation(),
    dispose: () => {
      actor.stop()
    },
  }
}
