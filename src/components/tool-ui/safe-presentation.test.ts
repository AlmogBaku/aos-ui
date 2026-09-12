import { describe, expect, it } from "vitest"

import { safeJsonStringify } from "./common"
import { safeToolDisplayValue, safeToolPresentation } from "./safe-presentation"

describe("safe tool presentation", () => {
  it("redacts credential fields before exposing provider payloads", () => {
    const presentation = safeJsonStringify({
      authorization: "Bearer provider-secret",
      nested: { apiToken: "private-token" },
      title: "Deployment complete",
    })

    expect(presentation).toContain('"authorization": "[REDACTED]"')
    expect(presentation).toContain('"apiToken": "[REDACTED]"')
    expect(presentation).not.toContain("provider-secret")
    expect(presentation).not.toContain("private-token")
  })

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
      bearer: "Bearer raw-provider-secret",
      veryLong: "x".repeat(30_000),
    })

    expect(presentation.text).toContain("[Circular]")
    expect(presentation.text).toContain("[Unserializable value]")
    expect(presentation.text).toContain("[Truncated]")
    expect(presentation.text).toContain("[REDACTED]")
    expect(presentation.text).not.toContain("raw-provider-secret")
    expect(presentation.text.length).toBeLessThanOrEqual(24_000)
    expect(presentation.title).toBe("Provider response")
  })

  it("redacts credential-shaped string values without relying on a field name", () => {
    const presentation = safeToolPresentation(
      "Provider returned access_token=raw-secret-value"
    )

    expect(presentation.text).toContain("[REDACTED]")
    expect(presentation.text).not.toContain("raw-secret-value")
    expect(presentation.title).toBe("[REDACTED]")
  })

  it("derives timeline labels from sanitized provider values", () => {
    const hostile = Object.defineProperty({}, "query", {
      enumerable: true,
      get() {
        throw new Error("provider getter failed")
      },
    })

    expect(
      safeToolDisplayValue(
        { query: "api_key=raw-secret" },
        ["query"],
        "tool"
      )
    ).toBe("[REDACTED]")
    expect(safeToolDisplayValue(hostile, ["query"], "tool")).toBe(
      "[Unserializable value]"
    )
  })

  it("never exceeds its byte budget when a bounded object is still large", () => {
    const presentation = safeToolPresentation(
      Array.from({ length: 100 }, () => "x".repeat(4_000))
    )

    expect(presentation.text.length).toBeLessThanOrEqual(24_000)
    expect(presentation.text).toContain("[Truncated]")
  })

  it("applies the byte budget to multibyte provider text", () => {
    const presentation = safeToolPresentation(
      Array.from({ length: 100 }, () => "א".repeat(4_000))
    )

    expect(
      new TextEncoder().encode(presentation.text).byteLength
    ).toBeLessThanOrEqual(24_000)
    expect(presentation.text).toContain("[Truncated]")
  })
})
