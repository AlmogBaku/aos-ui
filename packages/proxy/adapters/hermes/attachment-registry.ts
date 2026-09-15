/**
 * Hermes keeps a volatile native Session id behind a durable dashboard Session.
 * This registry is deliberately private to the Hermes adapter: callers only use
 * durable Agent/Session identities and never observe transport details.
 */
export type HermesAttachmentScope = {
  agentId: string
  sessionId: string
  threadId: string
}

export type HermesAttachment = HermesAttachmentScope & {
  liveSessionId: string
}

type RegistryNative = {
  resume(scope: HermesAttachmentScope): Promise<{ liveSessionId: string }>
  close(liveSessionId: string): Promise<void>
  observe(
    listener: (event: unknown) => void,
    disconnected: (error?: Error) => void
  ): Promise<() => void>
}

type Entry = {
  attachment: HermesAttachment
  resuming?: Promise<HermesAttachment>
  retainers: Map<string, number>
  listeners: Set<(event: unknown) => void>
  resets: Set<(error?: Error) => void>
  idle?: ReturnType<typeof setTimeout>
}

function key(scope: Pick<HermesAttachmentScope, "agentId" | "sessionId">) {
  return `${scope.agentId}\u0000${scope.sessionId}`
}

function liveId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

function eventLiveId(event: unknown) {
  if (!event || typeof event !== "object" || !("session_id" in event))
    return undefined
  return liveId(event.session_id) ? event.session_id : undefined
}

export class HermesAttachmentRegistry {
  readonly #entries = new Map<string, Entry>()
  readonly #byLiveId = new Map<string, Entry>()
  readonly #idleMs: number
  #observation: Promise<void> | undefined
  #stopObservation: (() => void) | undefined

  constructor(
    private readonly native: RegistryNative,
    options: { idleMs?: number } = {}
  ) {
    this.#idleMs = options.idleMs ?? 300_000
  }

  async ensure(scope: HermesAttachmentScope): Promise<HermesAttachment> {
    const entry = this.#entry(scope)
    this.#cancelIdle(entry)
    if (entry.attachment.liveSessionId) return entry.attachment
    if (!entry.resuming) {
      entry.resuming = this.#resume(entry)
      void entry.resuming.then(
        () => {
          entry.resuming = undefined
        },
        () => {
          entry.resuming = undefined
        }
      )
    }
    return entry.resuming
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

  async subscribe(
    scope: HermesAttachmentScope,
    listener: (event: unknown) => void,
    reset?: (error?: Error) => void
  ) {
    await this.ensure(scope)
    await this.#observe()
    const entry = this.#entry(scope)
    entry.listeners.add(listener)
    if (reset) entry.resets.add(reset)
    const release = await this.retain(scope, "subscriber")
    return () => {
      entry.listeners.delete(listener)
      if (reset) entry.resets.delete(reset)
      release()
    }
  }

  async subscribeLive(
    liveSessionId: string,
    listener: (event: unknown) => void,
    reset?: (error?: Error) => void
  ) {
    const entry = this.#byLiveId.get(liveSessionId)
    if (!entry) throw new Error("Hermes Session is not attached")
    return this.subscribe(entry.attachment, listener, reset)
  }

  async close() {
    this.#stopObservation?.()
    this.#stopObservation = undefined
    for (const entry of this.#entries.values()) {
      this.#cancelIdle(entry)
      // Shutdown detaches work. A retained Session can still be running,
      // stopping, waiting for input, or reconciling; never issue native Stop
      // or close it as a side effect of AOS going away.
      if (entry.retainers.size === 0 && entry.attachment.liveSessionId)
        await this.native
          .close(entry.attachment.liveSessionId)
          .catch(() => undefined)
    }
    this.#entries.clear()
    this.#byLiveId.clear()
  }

  #entry(scope: HermesAttachmentScope) {
    const id = key(scope)
    let entry = this.#entries.get(id)
    if (!entry) {
      entry = {
        attachment: { ...scope, liveSessionId: "" },
        retainers: new Map(),
        listeners: new Set(),
        resets: new Set(),
      }
      this.#entries.set(id, entry)
    }
    return entry
  }

  async #resume(entry: Entry) {
    const resumed = await this.native.resume(entry.attachment)
    if (!liveId(resumed.liveSessionId))
      throw new Error("Hermes returned an invalid Session")
    if (entry.attachment.liveSessionId)
      this.#byLiveId.delete(entry.attachment.liveSessionId)
    entry.attachment = {
      ...entry.attachment,
      liveSessionId: resumed.liveSessionId,
    }
    this.#byLiveId.set(resumed.liveSessionId, entry)
    this.#scheduleIdle(entry)
    return entry.attachment
  }

  async #observe() {
    if (this.#stopObservation) return
    if (!this.#observation)
      this.#observation = this.native
        .observe(
          (event) => {
            const id = eventLiveId(event)
            const entry = id ? this.#byLiveId.get(id) : undefined
            if (!entry) return
            this.#cancelIdle(entry)
            for (const listener of entry.listeners) listener(event)
            this.#scheduleIdle(entry)
          },
          (error) => {
            this.#stopObservation = undefined
            this.#observation = undefined
            for (const entry of this.#entries.values()) {
              if (entry.attachment.liveSessionId)
                this.#byLiveId.delete(entry.attachment.liveSessionId)
              entry.attachment = { ...entry.attachment, liveSessionId: "" }
              for (const reset of entry.resets) reset(error)
            }
          }
        )
        .then((stop) => {
          this.#stopObservation = stop
        })
        .finally(() => {
          this.#observation = undefined
        })
    await this.#observation
  }

  #cancelIdle(entry: Entry) {
    if (!entry.idle) return
    clearTimeout(entry.idle)
    entry.idle = undefined
  }

  #scheduleIdle(entry: Entry) {
    this.#cancelIdle(entry)
    if (entry.retainers.size > 0 || !entry.attachment.liveSessionId) return
    entry.idle = setTimeout(() => {
      entry.idle = undefined
      if (entry.retainers.size > 0 || !entry.attachment.liveSessionId) return
      const liveSessionId = entry.attachment.liveSessionId
      this.#byLiveId.delete(liveSessionId)
      entry.attachment = { ...entry.attachment, liveSessionId: "" }
      void this.native.close(liveSessionId).catch(() => undefined)
    }, this.#idleMs)
  }
}
