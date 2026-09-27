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
import { backoffDelay } from "../../../lifecycle"
import { withinGrace } from "../../grace"
import {
  HermesAuthenticationError,
  HermesRpcRejectedError,
  type HermesLog,
  type HermesRpcTransport,
} from "./gateway"
import { isRecord, nativeId, publicReason, sessionKey } from "./native"

export type HermesAttachmentScope = {
  agentId: string
  providerSessionId: string
  sessionId: string
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
  /** Rejects with `HermesSessionGoneError` when Hermes has no such Session. */
  resume(
    scope: HermesAttachmentScope
  ): Promise<{ liveSessionId: string; running?: boolean; saved?: boolean }>
  close(liveSessionId: string): Promise<void>
  /** The registry dropped this Session's entry; drop what is kept beside it. */
  forget?(scope: HermesAttachmentScope): void
}

/**
 * Observation is not optional: a registry that could not subscribe would route
 * no frame and rebind no Session, so the hooks are required here rather than
 * silently skipped.
 */
type RegistryGateway = Required<
  Pick<HermesRpcTransport, "subscribeEvents" | "subscribeConnection">
>

type Entry = {
  attachment: HermesAttachment
  resuming?: Promise<HermesAttachment>
  retainers: Map<string, number>
  observers: Set<AttachmentObserver>
  /** Last known native turn state; a running Session is never closed. */
  running: boolean
  /**
   * Hermes holds a row for this Session. An unsaved draft lives only in the
   * live Session, so closing it natively would delete the draft; it is only
   * ever dropped locally. Hermes commits a turn's history before it sends
   * `message.complete`, so a completed turn marks the draft saved.
   */
  saved: boolean
  /** When Hermes last answered a resume for this entry. */
  resumedAt?: number
  idle?: ReturnType<typeof setTimeout>
  /** A running entry already spent its extra idle window without a frame. */
  graced?: boolean
  /**
   * The socket generation Hermes last answered a resume for this entry in. A
   * live id from an earlier one is no longer known to be attached to the
   * current socket, because a heal skipped this entry or its rebind has not
   * succeeded yet: the next `ensure()` resumes it so the durable Session is
   * rebound before anyone addresses it again.
   */
  generation: number
  /** The pending retry of a rebind that failed. */
  rebindRetry?: ReturnType<typeof setTimeout>
}

/** The full-jitter backoff a failed rebind is retried on. */
export const REBIND_BACKOFF = { baseMs: 1_000, capMs: 30_000 }

/** The codes Hermes rejects a call with when the Session it names is gone. */
const SESSION_GONE_CODES = new Set([4001, 4007, -32602])

/**
 * Hermes rejected a call because the Session it named is gone. On a live id
 * that means the binding must be rebound; only on the durable resume does it
 * mean the Session itself is gone.
 */
export function isSessionGone(error: unknown) {
  return (
    error instanceof HermesRpcRejectedError &&
    error.code !== undefined &&
    SESSION_GONE_CODES.has(error.code)
  )
}

/**
 * The durable Session is gone: Hermes answered its resume with no record, so
 * no rebind can bring it back.
 */
export class HermesSessionGoneError extends Error {
  constructor(options?: ErrorOptions) {
    super("The Hermes Session is gone", options)
    this.name = "HermesSessionGoneError"
  }
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
  /** Moves on every heal, restart and close. */
  #generation = 0

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
    this.#stopEvents = gateway.subscribeEvents((event) => this.#route(event))
    this.#stopConnection = gateway.subscribeConnection({
      restored: () => this.rebindAll(),
      lost: () => this.#reportLoss("disconnected"),
      epochChanged: () => this.#restart(),
    })
  }

  /** How many durable Sessions the registry holds an entry for. */
  get size() {
    return this.#entries.size
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
      !this.#stale(entry.generation) &&
      (!options.refresh || this.#resumedWithin(entry, options.freshForMs))
    ) {
      // Using a cached binding counts as activity: its idle window restarts.
      this.#scheduleIdle(entry)
      return entry.attachment
    }
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
      this.#forget(entry)
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
    const { agentId, providerSessionId, sessionId } = entry.attachment
    return { agentId, providerSessionId, sessionId }
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
    this.#forget(entry)
  }

  /**
   * The socket is open again, a new generation. Re-resume every bound Session
   * someone still cares about before the gateway releases callers waiting on
   * the connection, so no later call targets a live id this heal replaced.
   * Every other binding is stale from here: it is not worth a resume now, and
   * whoever addresses it next resumes it onto the current socket first.
   */
  async rebindAll(): Promise<void> {
    const generation = ++this.#generation
    const pending: Array<Promise<void>> = []
    for (const entry of [...this.#entries.values()])
      if (entry.attachment.liveSessionId && this.#inUse(entry))
        pending.push(this.#rebind(entry, generation))
    await Promise.all(pending)
  }

  async close() {
    this.#stopEvents()
    this.#stopConnection()
    // A rebind still in flight must not schedule a retry past close.
    this.#generation += 1
    const closing: Array<Promise<void>> = []
    for (const entry of this.#entries.values()) {
      this.#cancelIdle(entry)
      clearTimeout(entry.rebindRetry)
      // Shutdown detaches work. A retained or running Session can still be
      // working, stopping, waiting for input, or reconciling; never issue
      // native Stop or close it as a side effect of AOS going away.
      if (
        entry.retainers.size === 0 &&
        !entry.running &&
        entry.saved &&
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
        saved: true,
        generation: this.#generation,
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
        this.#forget(entry)
      }
      void resuming.then(clear, clear)
    }
    return entry.resuming
  }

  /**
   * Drop an entry nobody holds once it has no live Session. A resume reads
   * everything it kept again, so keeping it would only grow with every Session
   * the process ever touched.
   */
  #forget(entry: Entry) {
    if (entry.attachment.liveSessionId || entry.resuming || this.#inUse(entry))
      return
    const key = sessionKey(entry.attachment)
    if (this.#entries.get(key) !== entry) return
    this.#cancelIdle(entry)
    clearTimeout(entry.rebindRetry)
    this.#entries.delete(key)
    this.native.forget?.(entry.attachment)
  }

  async #resume(entry: Entry) {
    const previous = entry.attachment.liveSessionId
    const resumed = await this.native.resume(entry.attachment)
    const liveSessionId = liveId(resumed.liveSessionId)
    if (!liveSessionId) throw new Error("Hermes returned an invalid Session")
    if (previous) this.#byLiveId.delete(previous)
    entry.attachment = { ...entry.attachment, liveSessionId }
    // A reply only arrives on the socket that is open now.
    entry.generation = this.#generation
    entry.resumedAt = this.#now()
    if (typeof resumed.running === "boolean") entry.running = resumed.running
    entry.saved = resumed.saved !== false
    this.#byLiveId.set(liveSessionId, entry)
    this.#scheduleIdle(entry)
    // Hermes replaced the live Session, so every observed frame stream ends
    // here whether the resume came from a heal or from the next caller.
    if (previous && previous !== liveSessionId)
      this.#signal(entry, { kind: "lost", reason: "rebound" })
    return entry.attachment
  }

  /** True for a binding or a rebind from an earlier socket generation. */
  #stale(generation: number) {
    return generation !== this.#generation
  }

  /** Someone observes or retains this Session. */
  #inUse(entry: Entry) {
    return entry.observers.size > 0 || entry.retainers.size > 0
  }

  async #rebind(entry: Entry, generation: number, attempt = 0) {
    const previous = entry.attachment.liveSessionId
    try {
      // A live id that changed is announced by #resume, which owns the remap.
      const attachment = await this.#resumeOnce(entry)
      if (!this.#stale(generation) && attachment.liveSessionId === previous)
        this.#signal(entry, { kind: "reattached" })
    } catch (error) {
      // A later heal, restart or close owns this entry now.
      if (this.#stale(generation)) return
      // Nothing is left to rebind: whoever addresses the Session next learns
      // it is gone from its own resume.
      if (error instanceof HermesSessionGoneError) {
        this.invalidate(previous)
        this.#signal(entry, { kind: "lost", reason: "rebound" })
        return
      }
      // The binding stays addressable for a caller that already holds the
      // live id, but it stays stale until a retry or the next ensure()
      // resumes it. A refused token waits for the heal a new token brings.
      this.#log?.warn(
        { reason: publicReason(error), attempt },
        "hermes.attachment.rebind_failed"
      )
      if (!(error instanceof HermesAuthenticationError))
        this.#retryRebind(entry, generation, attempt)
    }
  }

  /**
   * Retry a failed rebind on backoff until it succeeds, Hermes says the
   * Session is gone, or a later generation takes the entry over.
   */
  #retryRebind(entry: Entry, generation: number, attempt: number) {
    clearTimeout(entry.rebindRetry)
    const retry = setTimeout(
      () => {
        entry.rebindRetry = undefined
        // A caller's ensure() may have rebound it, or nobody needs it any more.
        if (
          this.#stale(generation) ||
          !this.#stale(entry.generation) ||
          !entry.attachment.liveSessionId ||
          !this.#inUse(entry)
        )
          return
        void this.#rebind(entry, generation, attempt + 1).catch(
          (error: unknown) =>
            this.#log?.warn(
              { reason: publicReason(error) },
              "hermes.attachment.rebind_failed"
            )
        )
      },
      backoffDelay(attempt, REBIND_BACKOFF)
    )
    // Like the idle close, a retry never keeps the process alive.
    if (typeof retry !== "number") retry.unref()
    entry.rebindRetry = retry
  }

  #reportLoss(reason: "disconnected" | "restart") {
    for (const entry of [...this.#entries.values()])
      this.#signal(entry, { kind: "lost", reason })
  }

  /** Hermes restarted: every live id it minted before is dead. */
  #restart() {
    this.#generation += 1
    this.#byLiveId.clear()
    for (const entry of [...this.#entries.values()]) {
      this.#cancelIdle(entry)
      entry.attachment = { ...entry.attachment, liveSessionId: "" }
      entry.running = false
      this.#forget(entry)
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
    else if (event.type === "message.complete") {
      entry.running = false
      entry.saved = true
    } else if (event.type === "session.info") {
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
        this.#log?.warn(
          {
            kind: signal.kind,
            reason: publicReason(error),
          },
          "hermes.attachment.observer_failed"
        )
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
      if (entry.running || !entry.saved) {
        // Drop only the local binding; the next ensure() resumes the Session.
        // A turn silent for a whole grace window is one AOS cannot see any more
        // (typically a socket that never healed): Hermes reaps that orphan, so
        // AOS neither re-arms forever nor closes it. An unsaved draft exists
        // only in its live Session, which Hermes keeps while the socket lives;
        // closing it natively would delete the draft.
        this.invalidate(liveSessionId)
        return
      }
      this.#byLiveId.delete(liveSessionId)
      entry.attachment = { ...entry.attachment, liveSessionId: "" }
      this.native
        .close(liveSessionId)
        .catch((err: unknown) =>
          this.#log?.warn({ err }, "hermes.attachment.close_failed")
        )
      this.#forget(entry)
    }, this.#idleMs)
    // Idle retention is housekeeping: it must never be the reason the process
    // stays alive after everything else has been closed.
    if (typeof idle !== "number") idle.unref()
    entry.idle = idle
  }
}
