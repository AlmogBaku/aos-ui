import { describe, expect, it } from "vitest"

import { publicJsonValue } from "./json-value"

describe("publicJsonValue", () => {
  it("bounds a native value's depth, entries, and private keys", () => {
    let deep: unknown = "leaf"
    for (let level = 0; level < 10; level += 1) deep = { next: deep }
    let kept: unknown = publicJsonValue(deep)
    let depth = 0
    while (typeof kept === "object" && kept !== null && "next" in kept) {
      kept = kept.next
      depth += 1
    }
    expect(depth).toBe(8)

    const wide = Array.from({ length: 150 }, (_, index) => index)
    expect(publicJsonValue(wide)).toEqual(wide.slice(0, 100))

    expect(
      publicJsonValue({
        label: "kept",
        apiToken: "synthetic-token",
        clientSecret: "synthetic-secret",
        filePath: "/synthetic/path",
        providerMetadata: {},
      })
    ).toEqual({ label: "kept" })
  })
})
