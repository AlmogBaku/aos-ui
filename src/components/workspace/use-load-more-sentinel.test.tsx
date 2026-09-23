import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useLoadMoreSentinel } from "./use-load-more-sentinel"

describe("useLoadMoreSentinel", () => {
  const observers: IntersectionObserverCallback[] = []

  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          observers.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** One delivery to the newest observer, oldest crossing first. */
  const deliver = (...crossings: boolean[]) =>
    act(() =>
      observers.at(-1)?.(
        crossings.map(
          (isIntersecting) => ({ isIntersecting }) as IntersectionObserverEntry
        ),
        {} as IntersectionObserver
      )
    )

  function renderSentinel(loadKey: number) {
    const load = vi.fn()
    const view = renderHook(
      ({ loadKey }) => useLoadMoreSentinel({ load, disabled: false, loadKey }),
      { initialProps: { loadKey } }
    )
    act(() => view.result.current(document.createElement("div")))
    return { load, view }
  }

  it("reads when the sentinel comes into view", () => {
    const { load } = renderSentinel(1)
    deliver(true)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("takes the last crossing of a batched delivery as where the sentinel is", () => {
    const { load } = renderSentinel(1)
    // Mounted at the list's start, then scrolled to its end before delivery.
    deliver(true, false)
    expect(load).not.toHaveBeenCalled()
  })

  it("waits for a fresh observation after a read lands before reading again", () => {
    const { load, view } = renderSentinel(1)
    deliver(true)
    expect(load).toHaveBeenCalledTimes(1)

    // The page moved the rows: the sentinel's earlier place no longer counts.
    view.rerender({ loadKey: 2 })
    expect(load).toHaveBeenCalledTimes(1)
    deliver(false)
    expect(load).toHaveBeenCalledTimes(1)
    deliver(true)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not read again while a read that brought nothing stays in view", () => {
    const { load, view } = renderSentinel(1)
    deliver(true)
    view.rerender({ loadKey: 1 })
    deliver(true)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
