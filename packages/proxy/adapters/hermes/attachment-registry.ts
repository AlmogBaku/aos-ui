/**
 * Hermes keeps a volatile native Session id behind a durable dashboard Session.
 * This registry is deliberately private to the Hermes adapter: callers only use
 * durable Agent/Session identities and never observe transport details.
 *
 * Observation is owned here. The registry subscribes once to the gateway's
 * event and connection hooks and keeps that subscription for its whole life, so
 * a redial never multiplies deliveries. Bindings survive a socket loss because
 * Hermes keeps the live Session for its orphan grace; they are re-resumed on a
 * heal, dropped only when Hermes says the live id is gone, and cleared when
 * Hermes restarts.
 */
import { withinGrace } from "../../grace"
import {
  HermesRpcRejectedError,
  HermesUnavailableError,
  type HermesLog,
  type HermesRpcTransport,
} from "./gateway"
import { isRecord, nativeId, publicReason, sessionKey } from "./native"

export type HermesAttachmentScope = {
  agentId: string
  sessionId: string
  threadId: string
}

export type HermesAttachment = HermesAttachmentScope & {
  liveSessionId: string
}

/**
 * What an observer of one durable Session learns. `reattached` means the same
 * live Session answered after a heal, so a run can catch up from its cursor.
 * Every `lost` reason ends the observed frame stream: `rebound` and `restart`
 * mean the live id changed or died, `disconnected` means the socket stayed down
 * past the heal grace window.
 */
export type AttachmentSignal =
  | { kind: "event"; event: unknown }
  | { kind: "reattached" }
  | { kind: "lost"; reason: "disconnected" | "rebound" | "restart" }

export type AttachmentObserver = (signal: AttachmentSignal) => void

type RegistryNative = {
  resume(
    scope: HermesAttachmentScope
  ): Promise<{ liveSessionId: string; running?: boolean }>
  close(liveSessionId: string): Promise<void>
}

/**
 * Observation is not optional: a registry that could not subscribe would route
 * no frame and rebind no Session, so the hooks are required here rather than
 * silently skipped.
 */
type RegistryGateway = Required<
  Pick<HermesRpcTransport, "onEvent" | "onConnection">
>

type Entry = {
  attachment: HermesAttachment
  resuming?: Promise<HermesAttachment>
  retainers: Map<string, number>
  observers: Set<AttachmentObserver>
  /** Last known native turn state; a running Session is never closed. */
  running: boolean
  /** When Hermes last answered a resume for this entry. */
  resumedAt?: number
  idle?: ReturnType<typeof setTimeout>
  /** A running entry already spent its extra idle window without a frame. */
  graced?: boolean
  /**
   * The live id is bound but no longer known to be attached to the current
   * socket, because a heal skipped this entry or its resume failed. The next
   * `ensure()` resumes it so the durable Session is rebound before anyone
   * addresses it again.
   */
  stale?: boolean
}

/** Hermes reports a stale or reaped live Session id with these codes. */
const SESSION_GONE_CODES = new Set([4001, 4007])

/**
 * Hermes answered a session-scoped call with "that live Session is gone". It
 * extends the outage error so every public caller keeps its existing
 * classification, while a native client that maps transport failures can still
 * tell the registry to rebind the durable Session.
 */
export class HermesSessionGoneError extends HermesUnavailableError {
  constructor() {
    super()
    this.name = "HermesSessionGoneError"
  }
}

/** True when Hermes said the addressed live Session no longer exists. */
export function isSessionGone(error: unknown) {
  return (
    error instanceof HermesSessionGoneError ||
    (error instanceof HermesRpcRejectedError &&
      error.code !== undefined &&
      SESSION_GONE_CODES.has(error.code))
  )
}

/** Hermes live Session ids are bounded native identifiers. */
function liveId(value: unknown) {
  return nativeId(value, 256)
}

function eventLiveId(event: unknown) {
  if (!isRecord(event)) return undefined
  return liveId(event.session_id)
}

export class HermesAttachmentRegistry {
  readonly #entries = new Map<string, Entry>()
  readonly #byLiveId = new Map<string, Entry>()
  readonly #idleMs: number
  readonly #closeFlushMs: number
  readonly #now: () => number
  readonly #log: HermesLog | undefined
  readonly #stopEvents: () => void
  readonly #stopConnection: () => void

  constructor(
    private readonly native: RegistryNative,
    gateway: RegistryGateway,
    options: {
      idleMs?: number
      /** How long `close()` waits for its best-effort native closes (1 s). */
      closeFlushMs?: number
      now?: () => number
      log?: HermesLog
    } = {}
  ) {
    this.#idleMs = options.idleMs ?? 300_000
    this.#closeFlushMs = options.closeFlushMs ?? 1_000
    this.#now = options.now ?? Date.now
    this.#log = options.log
    this.#stopEvents = gateway.onEvent((event) => this.#route(event))
    this.#stopConnection = gateway.onConnection({
      restored: () => this.rebindAll(),
      lost: () => this.#reportLoss("disconnected"),
      epochChanged: () => this.#restart(),
    })
  }

  /**
   * The live Session behind a durable one, resuming it when AOS has no usable
   * binding. `refresh` asks Hermes again even when one exists: a caller that
   * needs the authoritative Session state (what is still waiting on it, whether
   * it is running) cannot read it from a cached binding. `freshForMs` bounds
   * that cost for a caller whose refresh only has to be recent, not immediate:
   * a binding Hermes answered for that recently is accepted as it stands, so a
   * burst of such callers costs one `session.resume` rather than one each.
   */
  async ensure(
    scope: HermesAttachmentScope,
    options: { refresh?: boolean; freshForMs?: number } = {}
  ): Promise<HermesAttachment> {
    const entry = this.#entry(scope)
    this.#cancelIdle(entry)
    // A heal keeps the old live id until its resume answers. Joining the
    // in-flight call means no caller leaves with an id this heal replaces.
    if (entry.resuming) return entry.resuming
    if (
      entry.attachment.liveSessionId &&
      !entry.stale &&
      (!options.refresh || this.#resumedWithin(entry, options.freshForMs))
    )
      return entry.attachment
    return this.#resumeOnce(entry)
  }

  #resumedWithin(entry: Entry, freshForMs: number | undefined) {
    return (
      freshForMs !== undefined &&
      entry.resumedAt !== undefined &&
      this.#now() - entry.resumedAt < freshForMs
    )
  }

  async retain(scope: HermesAttachmentScope, reason: string) {
    await this.ensure(scope)
    const entry = this.#entry(scope)
    entry.retainers.set(reason, (entry.retainers.get(reason) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = entry.retainers.get(reason) ?? 0
      if (count <= 1) entry.retainers.delete(reason)
      else entry.retainers.set(reason, count - 1)
      this.#scheduleIdle(entry)
    }
  }

  async subscribe(scope: HermesAttachmentScope, observer: AttachmentObserver) {
    // The retainer resumes the binding and is taken first: a subscription that
    // cannot be retained must leave no observer behind, because its caller got
    // no unsubscribe handle to remove one with.
    const release = await this.retain(scope, "subscriber")
    const entry = this.#entry(scope)
    entry.observers.add(observer)
    return () => {
      entry.observers.delete(observer)
      release()
    }
  }

  async subscribeLive(liveSessionId: string, observer: AttachmentObserver) {
    const entry = this.#byLiveId.get(liveSessionId)
    if (!entry) throw new Error("Hermes Session is not attached")
    return this.subscribe(entry.attachment, observer)
  }

  /**
   * The durable Session a live Hermes Session id is bound to, if AOS bound it.
   * A native frame or server request addresses the volatile id, so this is how
   * a Session-scoped concern routes one without keeping its own binding map.
   */
  scopeFor(liveSessionId: string): HermesAttachmentScope | undefined {
    const entry = this.#byLiveId.get(liveSessionId)
    if (!entry) return undefined
    const { agentId, sessionId, threadId } = entry.attachment
    return { agentId, sessionId, threadId }
  }

  /**
   * Hermes answered a session-scoped call with "that live Session is gone".
   * Drop the binding so the next `ensure()` resumes the durable Session again.
   */
  invalidate(liveSessionId: string) {
    const entry = this.#byLiveId.get(liveSessionId)
    if (!entry) return
    this.#byLiveId.delete(liveSessionId)
    if (entry.attachment.liveSessionId !== liveSessionId) return
    this.#cancelIdle(entry)
    entry.attachment = { ...entry.attachment, liveSessionId: "" }
    entry.running = false
  }

  /**
   * The socket is open again. Re-resume every bound Session someone still cares
   * about before the gateway releases callers waiting on the connection, so no
   * later call targets a live id this heal replaced.
   */
  async rebindAll(): Promise<void> {
    const pending: Array<Promise<void>> = []
    for (const entry of [...this.#entries.values()]) {
      if (!entry.attachment.liveSessionId) continue
      if (entry.observers.size === 0 && entry.retainers.size === 0) {
        // Nobody is waiting on this Session, so it is not worth a resume now;
        // whoever addresses it next resumes it onto the current socket first.
        entry.stale = true
        continue
      }
      pending.push(this.#rebind(entry))
    }
    await Promise.all(pending)
  }

  async close() {
    this.#stopEvents()
    this.#stopConnection()
    const closing: Array<Promise<void>> = []
    for (const entry of this.#entries.values()) {
      this.#cancelIdle(entry)
      // Shutdown detaches work. A retained or running Session can still be
      // working, stopping, waiting for input, or reconciling; never issue
      // native Stop or close it as a side effect of AOS going away.
      if (
        entry.retainers.size === 0 &&
        !entry.running &&
        entry.attachment.liveSessionId
      )
        closing.push(
          this.native
            .close(entry.attachment.liveSessionId)
            .catch(() => undefined)
        )
    }
    this.#entries.clear()
    this.#byLiveId.clear()
    await this.#flushCloses(closing)
  }

  /**
   * The courtesy close of every idle live Session, together and bounded. A
   * shutdown has already stopped observing Hermes, so a native call no socket
   * will answer must never hold the process open; Hermes reaps the orphan.
   */
  async #flushCloses(closing: ReadonlyArray<Promise<void>>) {
    if (closing.length === 0) return
    // Already in flight, so the bound covers them together rather than one
    // per-call timeout after another.
    await withinGrace(() => Promise.allSettled(closing), this.#closeFlushMs)
  }

  #entry(scope: HermesAttachmentScope) {
    const id = sessionKey(scope)
    let entry = this.#entries.get(id)
    if (!entry) {
      entry = {
        attachment: { ...scope, liveSessionId: "" },
        retainers: new Map(),
        observers: new Set(),
        running: false,
      }
      this.#entries.set(id, entry)
    }
    return entry
  }

  #resumeOnce(entry: Entry) {
    if (!entry.resuming) {
      const resuming = this.#resume(entry)
      entry.resuming = resuming
      const clear = () => {
        if (entry.resuming === resuming) entry.resuming = undefined
      }
      void resuming.then(clear, clear)
    }
    return entry.resuming
  }

  async #resume(entry: Entry) {
    const previous = entry.attachment.liveSessionId
    const resumed = await this.native.resume(entry.attachment)
    const liveSessionId = liveId(resumed.liveSessionId)
    if (!liveSessionId) throw new Error("Hermes returned an invalid Session")
    if (previous) this.#byLiveId.delete(previous)
    entry.attachment = { ...entry.attachment, liveSessionId }
    entry.stale = false
    entry.resumedAt = this.#now()
    if (typeof resumed.running === "boolean") entry.running = resumed.running
    this.#byLiveId.set(liveSessionId, entry)
    this.#scheduleIdle(entry)
    // Hermes replaced the live Session, so every observed frame stream ends
    // here whether the resume came from a heal or from the next caller.
    if (previous && previous !== liveSessionId)
      this.#signal(entry, { kind: "lost", reason: "rebound" })
    return entry.attachment
  }

  async #rebind(entry: Entry) {
    const previous = entry.attachment.liveSessionId
    try {
      // A live id that changed is announced by #resume, which owns the remap.
      const attachment = await this.#resumeOnce(entry)
      if (attachment.liveSessionId === previous)
        this.#signal(entry, { kind: "reattached" })
    } catch (error) {
      if (!isSessionGone(error)) {
        // The binding stays addressable for a caller that already holds the
        // live id, but it is no longer known to be attached to this socket:
        // mark it so the next ensure() resumes it before anyone addresses it.
        entry.stale = true
        this.#log?.warn("hermes.attachment.rebind_failed", {
          reason: publicReason(error),
        })
        return
      }
      this.invalidate(previous)
      this.#signal(entry, { kind: "lost", reason: "rebound" })
    }
  }

  #reportLoss(reason: "disconnected" | "restart") {
    for (const entry of [...this.#entries.values()])
      this.#signal(entry, { kind: "lost", reason })
  }

  /** Hermes restarted: every live id it minted before is dead. */
  #restart() {
    this.#byLiveId.clear()
    for (const entry of this.#entries.values()) {
      this.#cancelIdle(entry)
      entry.attachment = { ...entry.attachment, liveSessionId: "" }
      entry.running = false
    }
    this.#reportLoss("restart")
  }

  #route(event: unknown) {
    const id = eventLiveId(event)
    const entry = id ? this.#byLiveId.get(id) : undefined
    if (!entry) return
    this.#observeTurnState(entry, event)
    this.#cancelIdle(entry)
    this.#signal(entry, { kind: "event", event })
    this.#scheduleIdle(entry)
  }

  /**
   * Track whether Hermes is running a turn on this live Session. AOS only holds
   * a retainer while it observes a run; a turn started elsewhere (or queued
   * after a steer) must still survive the idle close.
   */
  #observeTurnState(entry: Entry, event: unknown) {
    if (!isRecord(event)) return
    if (event.type === "message.start") entry.running = true
    else if (event.type === "message.complete") entry.running = false
    else if (event.type === "session.info") {
      const running = isRecord(event.payload)
        ? event.payload.running
        : undefined
      if (typeof running === "boolean") entry.running = running
    }
  }

  #signal(entry: Entry, signal: AttachmentSignal) {
    for (const observer of [...entry.observers])
      try {
        observer(signal)
      } catch (error) {
        this.#log?.warn("hermes.attachment.observer_failed", {
          kind: signal.kind,
          reason: publicReason(error),
        })
      }
  }

  #cancelIdle(entry: Entry) {
    if (!entry.idle) return
    clearTimeout(entry.idle)
    entry.idle = undefined
  }

  #scheduleIdle(entry: Entry, afterGrace = false) {
    this.#cancelIdle(entry)
    if (!afterGrace) entry.graced = false
    if (entry.retainers.size > 0 || !entry.attachment.liveSessionId) return
    const idle = setTimeout(() => {
      entry.idle = undefined
      if (entry.retainers.size > 0 || !entry.attachment.liveSessionId) return
      // Closing a running Session tears its turn down after a short native
      // join; grant one more idle window for the turn to report an edge.
      if (entry.running && !entry.graced) {
        entry.graced = true
        this.#scheduleIdle(entry, true)
        return
      }
      const liveSessionId = entry.attachment.liveSessionId
      if (entry.running) {
        // A whole grace window without one frame means AOS cannot see this
        // turn any more (typically a socket that never healed). Drop the local
        // binding instead of re-arming forever or closing a live turn: Hermes
        // reaps its own orphan and the next ensure() resumes the Session.
        this.invalidate(liveSessionId)
        return
      }
      this.#byLiveId.delete(liveSessionId)
      entry.attachment = { ...entry.attachment, liveSessionId: "" }
      void this.native.close(liveSessionId).catch(() => undefined)
    }, this.#idleMs)
    // Idle retention is housekeeping: it must never be the reason the process
    // stays alive after everything else has been closed.
    if (typeof idle !== "number") idle.unref()
    entry.idle = idle
  }
}
