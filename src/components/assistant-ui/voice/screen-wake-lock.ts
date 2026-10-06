/** The slice of a `WakeLockSentinel` the voice owner holds. */
export type WakeLockSentinelLike = {
  readonly released: boolean
  release(): Promise<void>
}

export type RequestWakeLock = () => Promise<WakeLockSentinelLike>

function browserRequest(): RequestWakeLock | undefined {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator))
    return undefined
  return () => navigator.wakeLock.request("screen")
}

/**
 * Keeps the screen on while voice work needs a visible page. The browser drops
 * the lock whenever the page hides, so `hold` takes it again on return. A change
 * applies once the current work finishes, so handing over from one reason to
 * hold it to the next never lets the lock go.
 */
export class ScreenWakeLock {
  readonly #request: RequestWakeLock | undefined
  #wanted = false
  #scheduled = false
  #requesting = false
  #sentinel?: WakeLockSentinelLike

  constructor(request = browserRequest()) {
    this.#request = request
  }

  hold(wanted: boolean) {
    this.#wanted = wanted
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      this.#settle()
    })
  }

  #settle() {
    if (!this.#wanted) {
      const sentinel = this.#sentinel
      this.#sentinel = undefined
      sentinel?.release().catch(() => {
        /* Already released by the browser. */
      })
      return
    }
    if (
      !this.#request ||
      this.#requesting ||
      (this.#sentinel && !this.#sentinel.released)
    )
      return
    this.#requesting = true
    this.#request().then(
      (sentinel) => {
        this.#requesting = false
        this.#sentinel = sentinel
        if (!this.#wanted) this.#settle()
      },
      () => {
        // Refused for a hidden page or by policy: the voice work still runs.
        this.#requesting = false
      }
    )
  }
}
