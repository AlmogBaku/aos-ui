import { describe, expect, it } from "vitest"

import {
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_ENTRIES,
  boundedGraphBytes,
  boundedNativeBytes,
  isRecord,
  nativeId,
  parseJson,
  parseJsonOrValue,
  timestamp,
  utf8BytesWithin,
} from "./native"

// ---------------------------------------------------------------------------
// isRecord
// ---------------------------------------------------------------------------

describe("isRecord", () => {
  it("accepts plain objects and rejects arrays, null, and primitives", () => {
    expect(isRecord({ a: 1 })).toBe(true)
    for (const value of [[], null, "string", 42, true, undefined])
      expect(isRecord(value)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseJson / parseJsonOrValue
// ---------------------------------------------------------------------------

describe("parseJson", () => {
  it("parses a JSON string, returns undefined when it is invalid, and passes non-strings through", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson("null")).toBeNull()
    expect(parseJson("{broken")).toBeUndefined()
    expect(parseJson(42)).toBe(42)
    expect(parseJson({ x: 1 })).toEqual({ x: 1 })
  })
})

describe("parseJsonOrValue", () => {
  it("parses a JSON string, returns an invalid one unchanged, and passes non-strings through", () => {
    expect(parseJsonOrValue('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonOrValue("{broken")).toBe("{broken")
    expect(parseJsonOrValue(42)).toBe(42)
    expect(parseJsonOrValue({ x: 1 })).toEqual({ x: 1 })
  })
})

// ---------------------------------------------------------------------------
// utf8BytesWithin
// ---------------------------------------------------------------------------

describe("utf8BytesWithin", () => {
  it("counts ASCII and multi-byte characters", () => {
    expect(utf8BytesWithin("hello", 100)).toBe(5)
    expect(utf8BytesWithin("é☺𠀀", 100)).toBe(9)
    expect(utf8BytesWithin("", 0)).toBe(0)
  })

  it("returns the count exactly at the maximum and undefined past it", () => {
    expect(utf8BytesWithin("abc", 3)).toBe(3)
    expect(utf8BytesWithin("abc", 2)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// boundedGraphBytes
// ---------------------------------------------------------------------------

describe("boundedGraphBytes", () => {
  it("returns undefined when maximum is exceeded", () => {
    // A large string should exceed a very small maximum
    expect(boundedGraphBytes("hello world", 2)).toBeUndefined()
  })

  it("returns undefined for circular structures", () => {
    const obj: Record<string, unknown> = {}
    obj["self"] = obj
    expect(boundedGraphBytes(obj, 10_000)).toBeUndefined()
  })

  it(`returns undefined beyond ${MAX_GRAPH_DEPTH} nesting levels`, () => {
    // Build a deeply nested object exceeding MAX_GRAPH_DEPTH
    let nested: unknown = "leaf"
    for (let i = 0; i <= MAX_GRAPH_DEPTH + 1; i += 1) nested = { child: nested }
    expect(boundedGraphBytes(nested, 1_000_000)).toBeUndefined()
  })

  it(`returns undefined beyond ${MAX_GRAPH_ENTRIES} entries`, () => {
    // Array with MAX_GRAPH_ENTRIES + 1 items
    const arr = Array.from({ length: MAX_GRAPH_ENTRIES + 1 }, (_, i) => i)
    expect(boundedGraphBytes(arr, 1_000_000)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// boundedNativeBytes
// ---------------------------------------------------------------------------

describe("boundedNativeBytes", () => {
  it("accepts a wide graph an entry bound would refuse", () => {
    const wide = { items: Array.from({ length: 3_000 }, (_, index) => index) }

    expect(boundedNativeBytes(wide, 4_194_304)).toBe(
      Buffer.byteLength(JSON.stringify(wide), "utf8")
    )
    expect(boundedGraphBytes(wide, 4_194_304)).toBeUndefined()
  })

  it("refuses a payload past its byte bound", () => {
    expect(boundedNativeBytes({ text: "x".repeat(4_194_305) }, 4_194_304)).toBe(
      undefined
    )
    expect(boundedNativeBytes("ok", 0)).toBeUndefined()
  })

  it("refuses a payload outside the shared native shape bound", () => {
    const deep = JSON.parse(`${"[".repeat(40)}null${"]".repeat(40)}`) as unknown
    const many = Array.from({ length: 200_001 }, () => 0)

    expect(boundedNativeBytes(deep, 4_194_304)).toBeUndefined()
    expect(boundedNativeBytes(many, 4_194_304)).toBeUndefined()
  })

  it("refuses a value JSON cannot serialize", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(boundedNativeBytes(circular, 4_194_304)).toBeUndefined()
    expect(boundedNativeBytes(undefined, 4_194_304)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// nativeId
// ---------------------------------------------------------------------------

describe("nativeId", () => {
  it("accepts a printable ASCII string up to maxLength", () => {
    expect(nativeId("live-session-abc", 256)).toBe("live-session-abc")
    expect(nativeId("a".repeat(256), 256)).toBe("a".repeat(256))
    expect(nativeId("a".repeat(300), 512)).toBe("a".repeat(300))
  })

  it("rejects an empty string or one longer than maxLength", () => {
    expect(nativeId("", 256)).toBeUndefined()
    expect(nativeId("a".repeat(257), 256)).toBeUndefined()
  })

  it("rejects control characters, DEL, and non-string values", () => {
    for (const value of [
      "hello\nworld",
      "\x00null",
      "del\x7fchar",
      null,
      42,
      {},
    ])
      expect(nativeId(value, 256)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// timestamp
// ---------------------------------------------------------------------------

describe("timestamp", () => {
  it("treats values below 10_000_000_000 as epoch-seconds, numeric strings included", () => {
    expect(timestamp(1)).toBe("1970-01-01T00:00:01.000Z")
    expect(timestamp(1_700_000_000)).toBe(
      new Date(1_700_000_000 * 1000).toISOString()
    )
    expect(timestamp("1000")).toBe(new Date(1000 * 1000).toISOString())
  })

  it("treats values from 10_000_000_000 as epoch-milliseconds", () => {
    expect(timestamp(10_000_000_000)).toBe(
      new Date(10_000_000_000).toISOString()
    )
  })

  it("falls back to epoch for zero, negative, and non-numeric values", () => {
    for (const value of [0, -1, null, undefined, "not-a-number", {}])
      expect(timestamp(value)).toBe("1970-01-01T00:00:00.000Z")
  })
})
