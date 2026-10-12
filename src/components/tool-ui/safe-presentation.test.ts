import { describe, expect, it } from "vitest"

import { safeToolDisplayValue, safeToolPresentation } from "./safe-presentation"

describe("safe tool presentation", () => {
  it("keeps cyclic, hostile, and oversized provider values inspectable within bounds", () => {
    const cyclic: { self?: unknown; items?: unknown[] } = {}
    cyclic.self = cyclic
    cyclic.items = Array.from({ length: 120 }, (_, index) => ({ index }))
    const hostile = Object.defineProperty({}, "message", {
      enumerable: true,
      get() {
        throw new Error("provider getter failed")
      },
    })

    const presentation = safeToolPresentation({
      title: "Provider response\nnever a second title line",
      cyclic,
      hostile,
      veryLong: "x".repeat(30_000),
    })

    expect(presentation.text).toContain("[Circular]")
    expect(presentation.text).toContain("[Unserializable value]")
    expect(presentation.text).toContain("[Truncated]")
    expect(presentation.text.length).toBeLessThanOrEqual(24_000)
    expect(presentation.title).toBe("Provider response")
  })

  it("derives timeline labels from sanitized provider values", () => {
    const hostile = Object.defineProperty({}, "query", {
      enumerable: true,
      get() {
        throw new Error("provider getter failed")
      },
    })

    expect(safeToolDisplayValue(hostile, ["query"], "tool")).toBe(
      "[Unserializable value]"
    )
  })

  it.each([
    ["single-byte", "x"],
    ["multibyte", "א"],
  ])(
    "never exceeds its byte budget for large %s provider text",
    (_kind, character) => {
      const presentation = safeToolPresentation(
        Array.from({ length: 100 }, () => character.repeat(4_000))
      )

      expect(
        new TextEncoder().encode(presentation.text).byteLength
      ).toBeLessThanOrEqual(24_000)
      expect(presentation.text).toContain("[Truncated]")
    }
  )
})
