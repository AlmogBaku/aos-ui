/**
 * Binding a run to a live Hermes Session, and keeping its frames contiguous.
 *
 * A run publishes only frames that are its own and only in Hermes' own order: a
 * new turn starts past Hermes' watermark, a reconnect continues from the cursor
 * the run published, and a proxy restart can claim nothing but Hermes' own open
 * turn. Whenever a sequence is missing, one bounded read of Hermes' ring decides
 * whether the run can continue or the browser has to reconcile.
 */
import type {
  RunInterruptOutcome,
} from "../../core/events"

import { boundedNativeBytes, sessionKey } from "./native"
import { providerUnavailable, RUN_FAILURES } from "./run-failures"
import {
  bufferNativeEvent,
  drainBufferedEvents,
  firstBufferedSeq,
  nativeEvent,
  nativeEventBuffer,
  nativeEventSessionId,
  payloadOf,
  stableNativeId,
  type BufferedNativeEvents,
  type HermesNativeEvent,
  type HermesRecovery,
} from "./run-frames"
import { settleFrom } from "./run-settlement"
import {
  safelyUnsubscribe,
  settledStatus,
  type ActiveRun,
  type RunEngineHost,
} from "./run-state"

const MAX_RECOVERY_EVENTS = 4_096
const MAX_RECOVERY_BYTES = 4_194_304

/**
 * `barrier`: a new turn, so only frames past Hermes' watermark are its own.
 * `position`: a browser reconnect from the cursor the run already published.
 * `discover`: a proxy restart where only Hermes' own open turn is this run's.
 */
type AttachMode =
  | { kind: "barrier" }
  | { kind: "position"; epoch: string; after: number }
  | { kind: "discover" }

/**
 * Where a run's frames start once it is bound. `head` is Hermes' watermark when
 * a page was read, `reconcile` that Hermes cannot place this run in its ring.
 */
type AttachCursor = {
  epoch: string
  barrier: number
  head?: number
  replayed?: readonly HermesNativeEvent[]
  reconcile?: boolean
}

/** Why the observed frame stream ended. */
type LostReason = "disconnected" | "rebound" | "restart"

/**
 * The one path that binds a run to a live Hermes Session: a new turn, a
 * reconnect, discovery and an in-place reattach differ only in `mode`.
 */
export async function attachRun(
  host: RunEngineHost,
  active: ActiveRun,
  mode: AttachMode
) {
  const buffered = nativeEventBuffer()
  let accepting = false
  let reattached = false
  let lost: LostReason | undefined
  let interrupted: RunInterruptOutcome | undefined
  let unsubscribe: (() => void) | undefined
  let liveSessionId: string
  let cursor: AttachCursor
  safelyUnsubscribe(active.unsubscribe)
  // Hermes asks the user through server→client requests, not through the
  // event stream: an interrupt ends this segment wherever the request landed.
  const stopInterrupts = host.native.onInterrupt(active.scope, (outcome) => {
    if (accepting) host.finishInterrupt(active, outcome)
    else interrupted = outcome
  })
  try {
    ;({ liveSessionId } = await host.native.resume(active.scope))
    unsubscribe = await host.native.observe(liveSessionId, (signal) => {
      if (signal.kind === "event") {
        if (nativeEventSessionId(signal.event) !== liveSessionId) return
        if (!accepting) bufferNativeEvent(buffered, signal.event)
        else host.accept(active, signal.event)
        return
      }
      if (signal.kind === "reattached") {
        // Hermes kept this live Session across the heal; its ring holds
        // whatever the socket missed.
        if (accepting) scheduleCatchUp(host, active)
        else reattached = true
        return
      }
      if (signal.kind !== "lost") return
      lost = signal.reason
      if (accepting) lostRun(host, active, signal.reason)
    })
    cursor = await attachCursor(host, liveSessionId, mode)
  } catch {
    safelyUnsubscribe(unsubscribe)
    stopInterrupts()
    active.uncertain = true
    active.detached = true
    active.queue.close()
    throw providerUnavailable()
  }
  active.liveSessionId = liveSessionId
  active.unsubscribe = () => {
    stopInterrupts()
    unsubscribe?.()
  }
  active.epoch = cursor.epoch
  active.lastSeen = cursor.barrier
  active.catchUp = undefined
  active.deferredEdge = undefined
  host.runs.set(sessionKey(active.scope), active)
  if (cursor.reconcile || buffered.overflow) {
    drainBufferedEvents(buffered)
    return host.fail(active, RUN_FAILURES.resetRequired)
  }
  if (lost) {
    drainBufferedEvents(buffered)
    return lostRun(host, active, lost)
  }
  if (cursor.replayed && !acceptReplayed(host, active, cursor.replayed)) {
    drainBufferedEvents(buffered)
    return host.fail(active, RUN_FAILURES.resetRequired)
  }
  // A watermark past the last frame this page carried means the sequences
  // in between are missing rather than delivered: read the ring once more.
  if (cursor.head !== undefined && cursor.head > active.lastSeen)
    scheduleCatchUp(host, active)
  accepting = true
  for (const event of drainBufferedEvents(buffered))
    host.accept(active, event, true)
  if (reattached) scheduleCatchUp(host, active)
  if (interrupted) host.finishInterrupt(active, interrupted)
}

/** The cursor each attach mode derives from Hermes' own ring. */
async function attachCursor(
  host: RunEngineHost,
  liveSessionId: string,
  mode: AttachMode
): Promise<AttachCursor> {
  // A new turn needs only Hermes' current epoch and watermark: retained
  // frames belong to earlier turns and to authoritative history.
  if (mode.kind === "barrier") {
    const cursor = await host.native.cursor(liveSessionId)
    return { epoch: cursor.epoch, barrier: cursor.latestSeq }
  }
  if (mode.kind === "position") {
    const recovery = await host.native.replay(liveSessionId, mode.after)
    const events = validatedReplay(recovery, liveSessionId, mode.after)
    const position = {
      epoch: recovery.epoch,
      barrier: mode.after,
      head: recovery.lastSeen,
    }
    return recovery.truncated === true ||
      !events ||
      recovery.epoch !== mode.epoch
      ? { ...position, reconcile: true }
      : { ...position, replayed: events }
  }
  const recovery = await host.native.replay(liveSessionId, 0)
  const events = validatedReplay(recovery, liveSessionId, 0)
  const open = events && openTurnFrames(events)
  if (open)
    return {
      epoch: recovery.epoch,
      barrier: open[0]!.seq! - 1,
      head: recovery.lastSeen,
      replayed: open,
    }
  if (!events || settledStatus(await host.native.status(liveSessionId)))
    return {
      epoch: recovery.epoch,
      barrier: recovery.lastSeen,
      reconcile: true,
    }
  // Hermes is working but its ring no longer holds this turn's start;
  // authoritative history restores the earlier frames.
  const cursor = await host.native.cursor(liveSessionId)
  return { epoch: cursor.epoch, barrier: cursor.latestSeq }
}

/**
 * Every replayed frame must belong to this live Session, carry a sequence and
 * increase within the page Hermes reported. An unusable page is never partially
 * accepted: the caller reconciles instead.
 */
function validatedReplay(
  recovery: HermesRecovery,
  liveSessionId: string,
  after?: number
) {
  if (
    !stableNativeId(recovery.epoch) ||
    !Number.isSafeInteger(recovery.lastSeen) ||
    recovery.lastSeen < (after ?? 0) ||
    !Array.isArray(recovery.events) ||
    recovery.events.length > MAX_RECOVERY_EVENTS
  )
    return undefined
  const events: HermesNativeEvent[] = []
  let previous = after
  let recoveryBytes = 0
  for (const raw of recovery.events) {
    const bytes = boundedNativeBytes(raw, MAX_RECOVERY_BYTES - recoveryBytes)
    const event = nativeEvent(raw)
    if (
      bytes === undefined ||
      !event ||
      event.session_id !== liveSessionId ||
      event.seq === undefined ||
      (previous !== undefined && event.seq <= previous) ||
      event.seq > recovery.lastSeen
    )
      return undefined
    events.push(event)
    recoveryBytes += bytes
    previous = event.seq
  }
  return events
}

/**
 * The frames of the last native turn Hermes has not closed. `message.complete`
 * or an idle `session.info` closes a turn; everything before the last unclosed
 * `message.start` is an earlier turn's, and belongs to history alone.
 */
function openTurnFrames(events: readonly HermesNativeEvent[]) {
  let start = -1
  for (const [index, event] of events.entries()) {
    if (event.type === "message.start") start = index
    else if (
      event.type === "message.complete" ||
      (event.type === "session.info" && payloadOf(event).running === false)
    )
      start = -1
  }
  if (start === -1) return undefined
  const frames = events.slice(start)
  return frames[0]?.seq === undefined ? undefined : frames
}

/**
 * Replayed frames must continue the run's own sequence: a gap means Hermes
 * dropped frames only authoritative history can now reconcile.
 */
function acceptReplayed(
  host: RunEngineHost,
  active: ActiveRun,
  events: readonly HermesNativeEvent[]
) {
  for (const event of events) {
    if (active.terminal) return true
    if (event.seq === undefined) {
      host.accept(active, event, true)
      continue
    }
    if (event.seq <= active.lastSeen) continue
    if (event.seq !== active.lastSeen + 1) return false
    host.accept(active, event, true)
  }
  return true
}

/** Hold a live frame behind the single in-flight catch-up for this run. */
export function scheduleCatchUp(
  host: RunEngineHost,
  active: ActiveRun,
  value?: unknown
) {
  if (active.terminal) return
  const running = active.catchUp !== undefined
  const buffer = (active.catchUp ??= nativeEventBuffer())
  if (value !== undefined) bufferNativeEvent(buffer, value)
  if (!running) void catchUp(host, active)
}

/**
 * A catch-up page belongs to the attachment it was read for: after a detach or
 * a later attach it may neither advance the frozen watermark nor fail the run.
 */
function ownsCatchUp(active: ActiveRun, buffer: BufferedNativeEvents) {
  if (active.catchUp !== buffer) return false
  if (!active.terminal && !active.detached) return true
  active.catchUp = undefined
  return false
}

async function catchUp(host: RunEngineHost, active: ActiveRun) {
  const buffer = active.catchUp
  if (!buffer || active.terminal) return
  let recovery: HermesRecovery
  try {
    recovery = await host.native.replay(active.liveSessionId, active.lastSeen)
  } catch {
    if (!ownsCatchUp(active, buffer)) return
    active.catchUp = undefined
    // The run cannot be made contiguous while Hermes is unreachable; the
    // browser reconnects and replays from the frozen cursor.
    host.detach(active, RUN_FAILURES.connectionInterrupted)
    return
  }
  if (!ownsCatchUp(active, buffer)) return
  const events = validatedReplay(
    recovery,
    active.liveSessionId,
    active.lastSeen
  )
  active.catchUp = undefined
  const held = drainBufferedEvents(buffer)
  if (
    recovery.epoch !== active.epoch ||
    recovery.truncated === true ||
    !events ||
    buffer.overflow ||
    !acceptReplayed(host, active, events) ||
    // A held frame the page never reached means Hermes' ring no longer holds
    // the gap; an empty page with nothing held is a heal that missed nothing.
    (!active.terminal && firstBufferedSeq(held) > active.lastSeen + 1)
  ) {
    host.fail(active, RUN_FAILURES.resetRequired)
    return
  }
  for (const event of held) host.accept(active, event, true)
  const deferredEdge = active.deferredEdge
  active.deferredEdge = undefined
  if (deferredEdge) settleFrom(host, active, deferredEdge)
}

/** The observed frame stream ended; how it ended decides what the run does. */
function lostRun(host: RunEngineHost, active: ActiveRun, reason: LostReason) {
  if (reason === "disconnected")
    host.detach(active, RUN_FAILURES.connectionInterrupted)
  // A rebound or restarted live Session cannot answer for this run's cursor.
  else host.fail(active, RUN_FAILURES.resetRequired)
}
