import { afterEach, describe, expect, it, vi } from "vitest"

import { trackPairSensor } from "@/components/agent-icons/pointer-tracking"

function sensor() {
  return document.createElementNS("http://www.w3.org/2000/svg", "g")
}

function stubMedia({ fine = true, reducedMotion = false } = {}) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(pointer: fine)"
        ? fine
        : query === "(prefers-reduced-motion: reduce)"
          ? reducedMotion
          : false,
  }))
}

function pointerMoveListeners(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([type]) => type === "pointermove")
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("trackPairSensor", () => {
  it("shares one passive listener across sensors and removes it with the last", () => {
    stubMedia()
    const add = vi.spyOn(window, "addEventListener")
    const remove = vi.spyOn(window, "removeEventListener")

    const first = trackPairSensor(sensor())
    const second = trackPairSensor(sensor())
    expect(pointerMoveListeners(add)).toHaveLength(1)
    expect(pointerMoveListeners(add)[0][2]).toEqual({ passive: true })

    first?.()
    expect(pointerMoveListeners(remove)).toHaveLength(0)
    second?.()
    expect(pointerMoveListeners(remove)).toHaveLength(1)
  })

  it("requests at most one animation frame per burst of pointer moves", () => {
    stubMedia()
    const frame = vi.fn()
    vi.stubGlobal("requestAnimationFrame", frame)
    const stop = trackPairSensor(sensor())

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 5 }))
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 9 }))
    expect(frame).toHaveBeenCalledTimes(1)

    frame.mock.calls[0][0](0)
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 12 }))
    expect(frame).toHaveBeenCalledTimes(2)
    stop?.()
  })

  it.each([
    ["a coarse pointer", { fine: false }],
    ["reduced motion", { reducedMotion: true }],
  ])("does not track under %s", (_, media) => {
    stubMedia(media)
    const add = vi.spyOn(window, "addEventListener")
    expect(trackPairSensor(sensor())).toBeUndefined()
    expect(pointerMoveListeners(add)).toHaveLength(0)
  })
})
