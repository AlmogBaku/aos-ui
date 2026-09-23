/**
 * When a Hermes run ends, and with which outcome.
 *
 * Hermes ends a native turn with a frame, but only Hermes going idle proves it
 * has nothing left to run for that turn: a correction in flight, a turn admitted
 * behind another one and an advisory `error` frame all outlive the frame that
 * looked terminal. `settleFrom` is the one place that precedence is decided, and
 * the settling watcher is what holds the next Send until Hermes is really done.
 */
import {
  ServerTurnConflictError,
  ServerTurnSteerUncertainError,
} from "../../core/runtime"
import { sessionKey } from "./native"
import {
  loggedFields,
  loggedNativeMessage,
  publicTurnFailure,
  stopUncertain,
  TURN_FAILED_LOG,
  TURN_FAILURES,
  TURN_NATIVE_ERROR_LOG,
  type NativeFailure,
} from "./run-failures"
import { nativeEvent, payloadOf } from "./run-frames"
import {
  deferred,
  readStatus,
  safelyUnsubscribe,
  settledStatus,
  type ActiveTurn,
  type TurnEngineHost,
  type SettlementEdge,
  type SettlingWatcher,
  type TurnOutcome,
} from "./run-state"

/** How long Hermes may keep a Session running after its completion frame. */
const SETTLING_WINDOW_MS = 5_000
const SETTLING_POLL_MS = 1_000
/** How long a turn Hermes admitted behind another one has to start. */
const QUEUED_START_GRACE_MS = 1_000
/** How many further bounded reads a turn that has not started may take. */
const QUEUED_START_REREADS = 4

/** Hermes' native turn status; anything unknown is read as a plain completion. */
export function turnOutcome(status: unknown): TurnOutcome {
  return status === "error"
    ? "failed"
    : status === "interrupted"
      ? "interrupted"
      : "complete"
}

/**
 * Whether this run has projected any assistant output. Every projection path
 * binds a message id first — `message.start`, a tool call, streamed text — and
 * sealing a generation moves that id into `sealedMessageIds`, so the two
 * together are the run's own record that Hermes ran something for it.
 */
function outputObserved(active: ActiveTurn) {
  return active.messageId !== undefined || active.sealedMessageIds.size > 0
}

function settlingWatcher(active: ActiveTurn): SettlingWatcher {
  const { promise, resolve } = deferred()
  const watcher: SettlingWatcher = {
    active,
    done: promise,
    settled: false,
    settle() {
      watcher.settled = true
      resolve()
    },
  }
  return watcher
}

/** Whether `done` resolved before `ms` elapsed. */
function resolvedWithin(done: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Hermes' authoritative answer to "is this Session's turn over?". */
export async function settleStale(host: TurnEngineHost, active: ActiveTurn) {
  const status = await readStatus(host, active.liveSessionId)
  if (status === undefined || !settledStatus(status))
    throw new ServerTurnConflictError()
  host.settle(active)
}

/**
 * The one place a terminal outcome is decided once the native turn is over.
 * `edge` records what proved Hermes has nothing left to run for this turn.
 */
export function settleFrom(
  host: TurnEngineHost,
  active: ActiveTurn,
  edge: SettlementEdge
) {
  if (active.terminal) return
  // A page read for a hole is authoritative about what this turn still holds,
  // so a status read cannot terminalize the run ahead of that page.
  if (active.catchUp) {
    active.deferredEdge = edge
    return
  }
  // A detached run publishes nothing; a confirmed idle edge only releases the
  // fence it holds on the Session.
  if (active.detached) {
    host.settle(active)
    return
  }
  // A correction deciding whether this turn continues, or an admitted turn
  // that has not started, makes this edge no outcome of this run's yet. A read
  // that found Hermes idle is still evidence: one bounded re-read decides.
  if (active.redirect.pending || active.awaitingStart) {
    if (edge === "idle" || (edge === "status" && active.awaitingStart))
      recheckSettlement(
        host,
        active,
        active.awaitingStart ? QUEUED_START_GRACE_MS : 0
      )
    return
  }
  if (active.stopping || active.turn === "interrupted")
    host.finish(active, { stopped: true }, true)
  // Hermes admitted this turn and went idle without ever running it, so no
  // assistant turn exists: report a failure the user can retry, not an empty
  // success. Anything observed while it waited belongs to the turn ahead of
  // it, so the failure is AOS' own rather than a native classification.
  else if (edge === "unstarted")
    failTurn(host, active, { failureReason: "queued-turn-not-started" })
  else if (active.turn === "failed" || active.errorObserved)
    failTurn(host, active)
  else if (active.turn === "complete") host.finish(active, undefined, true)
  // A correction chain has no completion frame of its own to wait for, so
  // Hermes' own idle frame ends it.
  else if (edge === "idle" && active.redirect.chain)
    host.finish(active, undefined, true)
  // An answered interaction resumes a turn Hermes already completed once, so it
  // has no completion frame left either: what this run published since the
  // answer is the outcome.
  else if (active.resumedInteraction) {
    if (outputObserved(active)) host.finish(active, undefined, true)
    // Hermes was idle while it held the question, so an idle frame from that
    // wait is no evidence the answer resumed nothing: one bounded re-read
    // decides, and a turn that started by then ends on its own frames.
    else if (edge === "idle")
      recheckSettlement(host, active, QUEUED_START_GRACE_MS)
    else failTurn(host, active, { failureReason: "resumed-turn-not-started" })
  }
  // Otherwise this is a mid-turn heartbeat: a bounded status read is too weak
  // to end a turn that is still open.
}

/** The only producer of a public run failure from a native turn outcome. */
export function failTurn(
  host: TurnEngineHost,
  active: ActiveTurn,
  override?: NativeFailure
) {
  const failure = override ?? active.failure ?? {}
  const { code, message } = publicTurnFailure(failure)
  host.log.warn(
    TURN_FAILED_LOG,
    loggedFields({
      publicCode: code,
      code: failure.code,
      layer: failure.layer,
      retryable: failure.retryable,
      failureReason: failure.failureReason,
      nativeMessage: loggedNativeMessage(failure),
    })
  )
  host.fail(active, { code, message })
}

/**
 * Re-read Hermes after something that could have ended the turn without a
 * usable edge: a correction in flight at the boundary, or an unstarted turn.
 */
function recheckSettlement(
  host: TurnEngineHost,
  active: ActiveTurn,
  delayMs: number,
  rereads = QUEUED_START_REREADS
) {
  const timer = setTimeout(
    () => void settleIfIdle(host, active, rereads),
    delayMs
  )
  // A re-read is reconciliation, never a reason to keep the process alive.
  if (typeof timer !== "number") timer.unref()
}

async function settleIfIdle(
  host: TurnEngineHost,
  active: ActiveTurn,
  rereads: number
) {
  if (active.terminal || active.redirect.pending) return
  // A failed read proves nothing; the re-reads below still bound the wait.
  const status = await readStatus(host, active.liveSessionId)
  if (active.terminal) return
  if (status !== undefined && settledStatus(status)) {
    // Hermes has no turn left, so nothing this run waits for can still
    // arrive. A turn still awaiting its start here was never run at all.
    const unstarted = active.awaitingStart
    active.awaitingStart = false
    settleFrom(host, active, unstarted ? "unstarted" : "status")
    return
  }
  // A busy read cannot say whether the admitted turn is starting or was
  // dropped: bounded re-reads keep a start that never comes from fencing.
  if (active.awaitingStart && rereads > 0)
    recheckSettlement(host, active, QUEUED_START_GRACE_MS, rereads - 1)
}

/**
 * A bare `error` frame is not a terminal contract: Hermes emits it for
 * advisory failures too. One status read decides, logged once per frame.
 */
export async function reconcileNativeError(
  host: TurnEngineHost,
  active: ActiveTurn,
  failure: NativeFailure
) {
  // A failed read cannot prove termination; later frames stay authoritative.
  const status = await readStatus(host, active.liveSessionId)
  const verdict =
    status === undefined
      ? "unconfirmed"
      : settledStatus(status)
        ? "terminal"
        : "advisory"
  host.log.warn(
    TURN_NATIVE_ERROR_LOG,
    loggedFields({
      verdict,
      status,
      nativeMessage: loggedNativeMessage(failure),
    })
  )
  if (active.terminal || verdict === "unconfirmed") return
  if (verdict === "advisory") {
    active.errorObserved = false
    // The turn kept running, so this frame is not the cause of any later
    // failure and must not be logged as one.
    if (active.failure === failure) active.failure = undefined
    return
  }
  settleFrom(host, active, "status")
}

export async function stopTurn(
  host: TurnEngineHost,
  active: ActiveTurn
): Promise<"stopping" | "idle"> {
  if (active.terminal) return "idle"
  if (!active.stopping) {
    active.stopping = true
    let outcome: "interrupted" | "gone"
    try {
      outcome = await host.native.interrupt(active.liveSessionId)
    } catch {
      // AOS cannot say whether Hermes accepted the cancel, so this run stops
      // consuming exactly like every other uncertain outcome: its cursor
      // freezes at the last delivered frame and the browser reconciles from
      // there. Following further frames would strand the turn's own end.
      host.detach(active, TURN_FAILURES.stopUncertain)
      throw stopUncertain()
    }
    // Hermes stating it has no live Session left is a confirmed Stop.
    if (outcome === "gone") {
      host.finish(active, { stopped: true }, true)
      return "idle"
    }
  }
  try {
    // Only idle or absent confirms Stop: a Session still building its Agent
    // has merely latched the cancel request.
    if (settledStatus(await host.native.status(active.liveSessionId))) {
      host.finish(active, { stopped: true }, true)
      return "idle"
    }
  } catch {
    // Stop was already acknowledged. An unavailable status read cannot make
    // the mutation safe to retry or prove that Hermes is idle.
  }
  return "stopping"
}

export async function steerTurn(
  host: TurnEngineHost,
  active: ActiveTurn,
  text: string
) {
  if (
    active.terminal ||
    active.stopping ||
    active.uncertain ||
    active.redirect.pending
  )
    throw new ServerTurnConflictError()
  const generation = active.generation
  const previousChain = active.redirect.chain
  active.redirect.pending = true
  try {
    const status = await host.native.redirect(active.liveSessionId, text)
    steerAcknowledged(host, active, generation, status === "queued")
    return status === "redirected" ? ("steered" as const) : ("queued" as const)
  } catch (error) {
    active.redirect.pending = false
    // Hermes may have applied a correction whose acknowledgement was lost, so
    // the run keeps following the chain; a rejected correction never landed.
    if (error instanceof ServerTurnSteerUncertainError)
      steerAcknowledged(host, active, generation, true)
    else {
      active.redirect.chain = previousChain
      if (active.turn !== "open" || active.errorObserved)
        recheckSettlement(host, active, 0)
    }
    throw error
  }
}

/** The correction is Hermes' now: this run follows the turn it lands in. */
function steerAcknowledged(
  host: TurnEngineHost,
  active: ActiveTurn,
  generation: number,
  queued: boolean
) {
  active.redirect.pending = false
  active.redirect.chain = true
  if (active.generation === generation) host.sealGeneration(active)
  // A queued correction runs only after the current turn's idle edge.
  if (queued) active.awaitingStart = true
  // A turn boundary may have passed while the correction was in flight, and a
  // queued correction may never be drained; only Hermes can say which.
  if (queued || active.turn !== "open" || active.errorObserved)
    recheckSettlement(host, active, queued ? QUEUED_START_GRACE_MS : 0)
}

export function watchSettling(host: TurnEngineHost, active: ActiveTurn) {
  const key = sessionKey(active.scope)
  host.settling.get(key)?.settle()
  const watcher = settlingWatcher(active)
  host.settling.set(key, watcher)
  void awaitSettled(host, key, watcher)
}

async function awaitSettled(
  host: TurnEngineHost,
  key: string,
  watcher: SettlingWatcher
) {
  const { active } = watcher
  const deadline = Date.now() + SETTLING_WINDOW_MS
  // A retainer only keeps the native binding warm, so a slow native resume
  // holds no Send: it is released whenever it arrives, and the wait below
  // runs on its own deadline.
  const retainer = host.native
    .retain(active.scope, "settling")
    .catch(() => undefined)
  await resolvedWithin(retainer, SETTLING_WINDOW_MS)
  while (!watcher.settled && Date.now() < deadline) {
    const read = host.native.status(active.liveSessionId).catch(() => undefined)
    // A slow native read may not hold the next Send past the window either.
    if (!(await resolvedWithin(read, deadline - Date.now()))) break
    const status = await read
    if (status === undefined || settledStatus(status)) break
    if (await resolvedWithin(watcher.done, SETTLING_POLL_MS)) break
  }
  watcher.settle()
  void retainer.then((release) => release?.())
  if (host.settling.get(key) === watcher) host.settling.delete(key)
  safelyUnsubscribe(active.unsubscribe)
}

/** After the turn ended, the only frame left that matters is Hermes idling. */
export function observeSettling(
  host: TurnEngineHost,
  active: ActiveTurn,
  value: unknown
) {
  const watcher = host.settling.get(sessionKey(active.scope))
  if (watcher?.active !== active) return
  const event = nativeEvent(value)
  if (event?.session_id !== active.liveSessionId) return
  if (event.type === "session.info" && payloadOf(event).running === false)
    watcher.settle()
}
