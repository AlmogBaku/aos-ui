import "@testing-library/jest-dom/vitest"

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollTo = () => {}
}
