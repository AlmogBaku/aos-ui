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
    expect(createRuntimeClock("aos", later).now).toEqual(later)
  })
  it("never selects a provider for an unknown or missing mode", () => {
    for (const mode of [undefined, "", "OPENCode", "other", "toString"]) {
      expect(isRuntimeMode(mode)).toBe(false)
      expect(getRuntimeEntrypoint(mode)).toBeUndefined()
    }
  })

  it("selects only fixture and the normalized AOS browser entrypoints", () => {
    expect(getRuntimeEntrypoint("fixture")).toBe(
      "/src/runtime-adapters/fixture/index.ts"
    )
    expect(getRuntimeEntrypoint("aos")).toBe(
      "/src/runtime-adapters/aos/index.ts"
    )
    for (const retiredMode of ["opencode", "hermes", "ag-ui", "openclaw"])
      expect(getRuntimeEntrypoint(retiredMode)).toBeUndefined()
  })
})
