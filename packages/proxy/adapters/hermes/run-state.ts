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
  RunInterruptOutcome,
  TokenUsage,
} from "../../core/events"

import type { SessionScope } from "../../core/runtime"
import type { HermesLog } from "./gateway"
import { HermesMediaTextFilter } from "./media-artifacts"
import { EventQueue, startedQueue } from "./event-queue"
import type { NativeFailure, RunFailure } from "./run-failures"
import type { BufferedNativeEvents } from "./run-frames"
import type { HermesNativeStatus, HermesRunNative } from "./run-native"

export type HermesRunScope = SessionScope

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
  readonly active: ActiveRun
  readonly done: Promise<void>
  settled: boolean
  settle(): void
}

export type ActiveRun = {
  scope: HermesRunScope
  runId: string
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
  reasoningStarted: boolean
  reasoningEnded: boolean
  streamedReasoning: string
  tools: Map<string, { name: string; ended: boolean; messageId: string }>
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
  /** Live frames waiting behind the one in-flight `session.events.since`. */
  catchUp?: BufferedNativeEvents
  /** A settlement edge a catch-up deferred; re-decided once the page drained. */
  deferredEdge?: SettlementEdge
  usage?: TokenUsage[]
  settled: Promise<void>
  resolveSettled(): void
}

/**
 * What the engine shell owns on behalf of every handler: the native boundary,
 * the runs and settling watchers it fences per Session, and the publication
 * steps only the shell may take.
 */
export type RunEngineHost = {
  readonly native: HermesRunNative
  readonly log: HermesLog
  /** The one run currently fencing each Session. */
  readonly runs: Map<string, ActiveRun>
  readonly settling: Map<string, SettlingWatcher>
  accept(active: ActiveRun, value: unknown, replayed?: boolean): void
  sealGeneration(active: ActiveRun): void
  finish(active: ActiveRun, result?: unknown, confirmedIdle?: boolean): void
  finishInterrupt(active: ActiveRun, outcome: RunInterruptOutcome): void
  fail(active: ActiveRun, failure: RunFailure): void
  detach(active: ActiveRun, failure: RunFailure): void
  settle(active: ActiveRun): void
}

/** A promise and its resolver: the one shape for AOS' own settlement edges. */
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function runSettlement() {
  const { promise, resolve } = deferred()
  return { settled: promise, resolveSettled: resolve }
}

/** The streaming state of one assistant generation; a sealed one starts over. */
export function generationState() {
  return {
    textStarted: false,
    streamedText: "" as string | undefined,
    mediaFilter: new HermesMediaTextFilter(),
    reasoningStarted: false,
    reasoningEnded: false,
    streamedReasoning: "",
  }
}

export function createActiveRun(
  scope: HermesRunScope,
  runId: string
): ActiveRun {
  return {
    scope,
    runId,
    liveSessionId: "",
    queue: startedQueue(scope, runId),
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
    ...runSettlement(),
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
  host: RunEngineHost,
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
