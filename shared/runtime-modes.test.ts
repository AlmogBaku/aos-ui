import { describe, expect, it } from "vitest"

import {
  createRuntimeClock,
  getRuntimeEntrypoint,
  isRuntimeMode,
} from "./runtime-modes"

describe("runtime selection", () => {
  it("keeps fixture Session age deterministic while real runtimes use the supplied clock", () => {
    const later = new Date("2030-01-01T00:00:00.000Z")
    const fixture = createRuntimeClock("fixture", later)
    expect(fixture.now.toISOString()).toBe("2026-09-03T12:00:00.000Z")
    expect(fixture.readNow().toISOString()).toBe("2026-09-03T12:00:00.000Z")
    expect(createRuntimeClock("ag-ui", later).now).toEqual(later)
  })
  it("never selects a provider for an unknown or missing mode", () => {
    for (const mode of [undefined, "", "OPENCode", "other", "toString"]) {
      expect(isRuntimeMode(mode)).toBe(false)
      expect(getRuntimeEntrypoint(mode)).toBeUndefined()
    }
  })

  it("selects the requested provider entrypoint", () => {
    expect(getRuntimeEntrypoint("fixture")).toBe(
      "/src/runtime-adapters/fixture/composition.tsx"
    )
    expect(getRuntimeEntrypoint("ag-ui")).toBe(
      "/src/runtime-adapters/ag-ui/composition.tsx"
    )
  })
})
