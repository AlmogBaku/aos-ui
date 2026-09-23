/**
 * The state one live Hermes run carries, and the engine surface its handlers
 * act through.
 *
 * `ActiveRun` is the single mutable record every handler in this adapter reads
 * and advances; `RunEngineHost` is what a handler may ask the engine shell to
 * do (accept a frame, seal a generation, end the run), so attach, catch-up and
 * settlement stay plain functions over the run instead of engine methods.
 */
import type {
  Cost,
  PendingRequest,
  TokenUsage,
  TurnEventKind,
  TurnEventOf,
} from "../../core/events"

import type { SessionScope } from "../../core/runtime"
import type { HermesLog } from "./gateway"
import { HermesMediaTextFilter } from "./media-artifacts"
import { EventQueue, startedTurnQueue } from "./event-queue"
import {
  TURN_FAILURES,
  TURN_RESET_LOG,
  type NativeFailure,
  type TurnFailure,
} from "./run-failures"
import type { BufferedNativeEvents } from "./run-frames"
import type { HermesNativeStatus, HermesTurnNative } from "./run-native"
import type { SessionModelChoice } from "./session-model"

export type HermesTurnScope = SessionScope

type TurnSaved = NonNullable<
  TurnEventOf<typeof TurnEventKind.TurnEnded>["saved"]
>

/** The native turn outcome; `open` means Hermes has not ended the turn yet. */
export type TurnOutcome = "open" | "complete" | "failed" | "interrupted"

/**
 * What proved Hermes has nothing left to run: its own idle `session.info`, an
 * authoritative status read, or such a read while an admitted turn had not run.
 */
export type SettlementEdge = "idle" | "status" | "unstarted"

/**
 * Hermes keeps the Session running after the completion frame while its turn
 * thread finishes bookkeeping, so the next Send waits here, not on "busy".
 */
export type SettlingWatcher = {
  readonly active: ActiveTurn
  readonly done: Promise<void>
  settled: boolean
  settle(): void
}

export type ActiveTurn = {
  scope: HermesTurnScope
  turnId: string
  liveSessionId: string
  queue: EventQueue
  unsubscribe: () => void
  epoch: string
  lastSeen: number
  messageId?: string
  generation: number
  sealedMessageIds: Set<string>
  textStarted: boolean
  streamedText?: string
  mediaFilter: HermesMediaTextFilter
  streamedReasoning: string
  tools: Map<string, { name: string; ended: boolean }>
  /** How the native turn this run follows ended, as Hermes reported it. */
  turn: TurnOutcome
  /** Hermes' own client-safe classification of a terminal failure. */
  failure?: NativeFailure
  /** A bare `error` frame arrived; only a status read says whether it settled. */
  errorObserved: boolean
  /** `chain`: a correction was accepted. `pending`: one is in flight. */
  redirect: { chain: boolean; pending: boolean }
  stopping: boolean
  uncertain: boolean
  /** The queue is closed and the native observer released; nothing may emit. */
  detached: boolean
  terminal: boolean
  /** Hermes accepted this turn but has not started it yet (queue, steer). */
  awaitingStart: boolean
  /**
   * This run answered a pending interaction, so it continues a native turn
   * whose completion frame already passed: Hermes idling is the only end it has.
   */
  resumedInteraction: boolean
  /** Live frames waiting behind the one in-flight `session.events.since`. */
  catchUp?: BufferedNativeEvents
  /** A settlement edge a catch-up deferred; re-decided once the page drained. */
  deferredEdge?: SettlementEdge
  /**
   * The user message this run's own prompt became. Only such a run can name
   * its turn's saved rows: AOS submits its prompt as a visible user row, so
   * history opens the turn with it.
   */
  promptMessageId?: string
  /** The ids Hermes' completion proved the turn was saved under. */
  saved?: TurnSaved
  usage?: TokenUsage[]
  cost?: Cost
  /** The model the Session last reported; a change is published. */
  model?: SessionModelChoice
  /** The call each background process Hermes streams output for belongs to. */
  terminals: Map<string, { toolCallId: string; terminalId: string }>
  /** The call that spawned each subagent Hermes reports on. */
  subagents: Map<string, string>
  /** The compaction Hermes is running, and how many this run has seen. */
  compaction: { open?: string; count: number }
  settled: Promise<void>
  resolveSettled(): void
}

/** How a cleanly finished run ended, beyond the fact that it did. */
export type TurnEnding = {
  /** The turn was stopped, so calls it left open end as stopped. */
  stopped?: true
  /** Text Hermes asks the composer to start the next prompt with. */
  composerPrefill?: string
}

/**
 * What the engine shell owns on behalf of every handler: the native boundary,
 * the runs and settling watchers it fences per Session, and the publication
 * steps only the shell may take.
 */
export type TurnEngineHost = {
  readonly native: HermesTurnNative
  readonly log: HermesLog
  /** The one run currently fencing each Session. */
  readonly turns: Map<string, ActiveTurn>
  readonly settling: Map<string, SettlingWatcher>
  accept(active: ActiveTurn, value: unknown, replayed?: boolean): void
  sealGeneration(active: ActiveTurn): void
  finish(active: ActiveTurn, ending?: TurnEnding, confirmedIdle?: boolean): void
  requireAction(active: ActiveTurn, requests: PendingRequest[]): void
  fail(active: ActiveTurn, failure: TurnFailure): void
  detach(active: ActiveTurn, failure: TurnFailure): void
  settle(active: ActiveTurn): void
}

/**
 * End a turn that must be reconciled with Hermes history. Every such path
 * publishes the same failure, so the log line names which one decided it.
 */
export function failReset(
  host: TurnEngineHost,
  active: ActiveTurn,
  reason: string
) {
  if (active.terminal) return
  host.log.warn(TURN_RESET_LOG, { sessionId: active.scope.sessionId, reason })
  host.fail(active, TURN_FAILURES.resetRequired)
}

/** A promise and its resolver: the one shape for AOS' own settlement edges. */
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function turnSettlement() {
  const { promise, resolve } = deferred()
  return { settled: promise, resolveSettled: resolve }
}

/** The streaming state of one assistant generation; a sealed one starts over. */
export function generationState() {
  return {
    textStarted: false,
    streamedText: "" as string | undefined,
    mediaFilter: new HermesMediaTextFilter(),
    streamedReasoning: "",
  }
}

export function createActiveTurn(
  scope: HermesTurnScope,
  turnId: string
): ActiveTurn {
  return {
    scope,
    turnId,
    liveSessionId: "",
    queue: startedTurnQueue(),
    unsubscribe: () => undefined,
    epoch: "",
    lastSeen: 0,
    generation: 0,
    sealedMessageIds: new Set(),
    ...generationState(),
    tools: new Map(),
    turn: "open",
    errorObserved: false,
    redirect: { chain: false, pending: false },
    stopping: false,
    uncertain: false,
    detached: false,
    terminal: false,
    awaitingStart: false,
    resumedInteraction: false,
    terminals: new Map(),
    subagents: new Map(),
    compaction: { count: 0 },
    ...turnSettlement(),
  }
}

export function safelyUnsubscribe(unsubscribe: (() => void) | undefined) {
  try {
    unsubscribe?.()
  } catch {
    // Native cleanup errors are intentionally not exposed across the proxy.
  }
}

/** Hermes' status, or `undefined` when the read itself failed. */
export async function readStatus(
  host: TurnEngineHost,
  liveSessionId: string
): Promise<HermesNativeStatus | undefined> {
  try {
    return await host.native.status(liveSessionId)
  } catch {
    return undefined
  }
}

/**
 * Hermes has no turn left to run: either it reports the Session idle or it no
 * longer lists it at all. An absent Session is never evidence of anything else.
 */
export function settledStatus(status: HermesNativeStatus) {
  return status === "idle" || status === "absent"
}
