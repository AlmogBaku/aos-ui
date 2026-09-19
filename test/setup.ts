import "@testing-library/jest-dom/vitest"
import { configure } from "@testing-library/react"

// `findBy*` and `waitFor` poll until the UI settles, so a longer ceiling costs a
// passing test nothing; the default 1s only decided how loaded the machine had
// to be before an ordinary async render read as a missing element.
configure({ asyncUtilTimeout: 10_000 })

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollTo = () => {}
}
