import "@testing-library/jest-dom/vitest"
import { configure, getConfig } from "@testing-library/react"
import { beforeEach } from "vitest"

let testSignal: AbortSignal | undefined
beforeEach(({ signal }) => {
  testSignal = signal
})

const { asyncWrapper } = getConfig()
configure({
  // `findBy*` and `waitFor` poll until the UI settles, so a longer ceiling costs
  // a passing test nothing; the default 1s only decided how loaded the machine
  // had to be before an ordinary async render read as a missing element.
  asyncUtilTimeout: 10_000,
  // Vitest aborts a timed out test's signal but cannot stop its function, and
  // a poll it left parked would resolve against the next test's render and act
  // on it. Each call, user-event's included, rejects once its own test aborts.
  asyncWrapper: (cb) => {
    const signal = testSignal
    if (!signal) return asyncWrapper(cb)
    signal.throwIfAborted()
    return Promise.race([
      asyncWrapper(cb),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      ),
    ])
  },
})

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollTo = () => {}
}
