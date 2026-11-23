import { cleanup, fireEvent, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../../test/support/fake-clock"
import {
  LAST_LOCATION_TTL_MS,
  readLastLocation,
  useRememberLocation,
  writeLastLocation,
} from "./last-location"

const market = "/agent-aster/thread-aster-market"
const quarterly = "/agent-mica/thread-mica-quarterly"

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A storage whose entry holds `path`, last used `ageMs` ago. */
const holding = (path: string, ageMs: number) => () => ({
  getItem: () => JSON.stringify({ path, usedAt: Date.now() - ageMs }),
  setItem: () => {},
})

describe("the stored last location", () => {
  it.each([
    {
      stored: "5 h 59 min ago",
      path: market,
      ageMs: LAST_LOCATION_TTL_MS - 60_000,
      restored: market,
    },
    {
      stored: "6 h ago",
      path: market,
      ageMs: LAST_LOCATION_TTL_MS,
      restored: null,
    },
    {
      stored: "a minute in the future",
      path: market,
      ageMs: -60_000,
      restored: null,
    },
    {
      stored: "with a trailing slash",
      path: "/agent-aster/",
      ageMs: 0,
      restored: null,
    },
    { stored: "naming no Agent", path: "/", ageMs: 0, restored: null },
  ])(
    "restores a path stored $stored only when it is fresh and canonical",
    ({ path, ageMs, restored }) => {
      expect(readLastLocation(holding(path, ageMs))).toBe(restored)
    }
  )

  it("restores nothing from an entry it cannot parse or storage the browser blocks", () => {
    const blocked = () => {
      throw new DOMException("site data is blocked", "SecurityError")
    }

    expect(
      readLastLocation(() => ({
        getItem: () => "{not json",
        setItem: () => {},
      }))
    ).toBeNull()
    expect(() => writeLastLocation(market, blocked)).not.toThrow()
    expect(readLastLocation(blocked)).toBeNull()
  })
})

describe("useRememberLocation", () => {
  it("stores the path on screen and keeps it alive on input, at most once a minute", async () => {
    const clock = useFakeClock()
    renderHook(() => useRememberLocation(market))
    expect(readLastLocation()).toBe(market)

    await clock.advance(30_000)
    fireEvent.keyDown(document)
    await clock.advance(LAST_LOCATION_TTL_MS - 30_000)
    // The keydown came within the minute, so the entry still dates from render.
    expect(readLastLocation()).toBeNull()

    fireEvent.pointerDown(document)
    await clock.advance(LAST_LOCATION_TTL_MS - 1_000)
    expect(readLastLocation()).toBe(market)
  })

  it("stores the tab used last, even within the minute", () => {
    useFakeClock()
    renderHook(() => useRememberLocation(market))
    // Another tab of the same browser writes its own location.
    writeLastLocation(quarterly)

    fireEvent.keyDown(document)

    expect(readLastLocation()).toBe(market)
  })

  it.each([
    { tab: "a hidden tab", visibility: "hidden" as const, path: quarterly },
    {
      tab: "a path that names no Agent",
      visibility: "visible" as const,
      path: "/",
    },
  ])("leaves the stored location alone from $tab", ({ visibility, path }) => {
    useFakeClock()
    writeLastLocation(market)
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility)

    renderHook(() => useRememberLocation(path))
    if (visibility === "visible") fireEvent.keyDown(document)

    expect(readLastLocation()).toBe(market)
  })
})
