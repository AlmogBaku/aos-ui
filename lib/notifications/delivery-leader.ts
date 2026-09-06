type LeaderOptions = {
  id: string
  now(): number
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
  locks?: {
    request(
      name: string,
      options: { signal: AbortSignal },
      callback: () => Promise<void>
    ): Promise<unknown>
  }
  repeat(callback: () => void, ms: number): () => void
}
const key = "aos-ui.activity.delivery.v1"
const leaseDuration = 10000
export class DeliveryLeader {
  readonly #options: LeaderOptions
  #leader = false
  #active = false
  constructor(options: LeaderOptions) {
    this.#options = options
  }
  start(onLeader: () => void = () => {}) {
    this.#active = true
    const { locks, repeat } = this.#options
    const abort = new AbortController()
    let release = () => {}
    let stopTimer = () => {}
    if (locks) {
      try {
        void locks
          .request(key, { signal: abort.signal }, async () => {
            if (!this.#active) return
            this.#leader = true
            const held = new Promise<void>((resolve) => {
              release = resolve
            })
            onLeader()
            await held
            this.#leader = false
          })
          .catch(() => {
            this.#leader = false
          })
      } catch {
        this.#leader = false
      }
    } else {
      const tick = () => {
        if (!this.#active) return
        try {
          const lease = this.#read()
          const now = this.#options.now()
          if (lease?.id === this.#options.id) {
            // A delayed heartbeat may find our own expired candidacy. It has
            // already settled; renew only if no peer replaced its identity.
            const newlyLeader = !this.#leader || lease.expires <= now
            this.#write(now)
            this.#leader = true
            if (newlyLeader) onLeader()
          } else {
            this.#leader = false
            // Settle contenders for one heartbeat before allowing side effects.
            if (!lease || lease.expires <= now) this.#write(now)
          }
        } catch {
          this.#leader = false
        }
      }
      tick()
      stopTimer = repeat(tick, 1000)
    }
    return () => {
      this.#active = false
      this.#leader = false
      abort.abort()
      release()
      stopTimer()
      if (!locks) {
        try {
          if (this.#read()?.id === this.#options.id)
            this.#options.storage.removeItem(key)
        } catch {}
      }
    }
  }
  isLeader() {
    if (!this.#active || !this.#leader) return false
    if (this.#options.locks) return true
    try {
      const lease = this.#read()
      if (lease?.id !== this.#options.id) return false
      const now = this.#options.now()
      // Delivery timers can wake before a throttled heartbeat. A settled
      // owner may renew its unchanged lease; a successor's identity fences it.
      if (lease.expires <= now) this.#write(now)
      return true
    } catch {
      return false
    }
  }
  #read(): { id: string; expires: number } | null {
    const raw = this.#options.storage.getItem(key)
    if (!raw) return null
    try {
      const value: unknown = JSON.parse(raw)
      if (
        typeof value !== "object" ||
        !value ||
        !("id" in value) ||
        !("expires" in value) ||
        typeof value.id !== "string" ||
        typeof value.expires !== "number" ||
        !Number.isFinite(value.expires)
      )
        return null
      return { id: value.id, expires: value.expires }
    } catch {
      return null
    }
  }
  #write(now: number) {
    this.#options.storage.setItem(
      key,
      JSON.stringify({ id: this.#options.id, expires: now + leaseDuration })
    )
  }
}
