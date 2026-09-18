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
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it("rejects arrays", () => {
    expect(isRecord([])).toBe(false)
    expect(isRecord([1, 2])).toBe(false)
  })

  it("rejects null", () => {
    expect(isRecord(null)).toBe(false)
  })

  it("rejects primitives", () => {
    expect(isRecord("string")).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(true)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseJson
// ---------------------------------------------------------------------------

describe("parseJson", () => {
  it("parses a valid JSON string", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson("[1,2,3]")).toEqual([1, 2, 3])
    expect(parseJson('"hello"')).toBe("hello")
    expect(parseJson("42")).toBe(42)
    expect(parseJson("null")).toBeNull()
  })

  it("returns undefined on invalid JSON string", () => {
    expect(parseJson("{broken")).toBeUndefined()
    expect(parseJson("undefined")).toBeUndefined()
  })

  it("passes non-string values through unchanged", () => {
    expect(parseJson(null)).toBeNull()
    expect(parseJson(42)).toBe(42)
    expect(parseJson({ x: 1 })).toEqual({ x: 1 })
    expect(parseJson(undefined)).toBeUndefined()
    expect(parseJson([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseJsonOrValue
// ---------------------------------------------------------------------------

describe("parseJsonOrValue", () => {
  it("parses a valid JSON string", () => {
    expect(parseJsonOrValue('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonOrValue("[1,2,3]")).toEqual([1, 2, 3])
    expect(parseJsonOrValue('"hello"')).toBe("hello")
    expect(parseJsonOrValue("42")).toBe(42)
    expect(parseJsonOrValue("null")).toBeNull()
  })

  it("returns the original string unchanged on invalid JSON (contrast with parseJson)", () => {
    expect(parseJsonOrValue("{broken")).toBe("{broken")
    expect(parseJsonOrValue("undefined")).toBe("undefined")
    expect(parseJsonOrValue("not json at all")).toBe("not json at all")
  })

  it("passes non-string values through unchanged", () => {
    expect(parseJsonOrValue(null)).toBeNull()
    expect(parseJsonOrValue(42)).toBe(42)
    expect(parseJsonOrValue({ x: 1 })).toEqual({ x: 1 })
    expect(parseJsonOrValue(undefined)).toBeUndefined()
    expect(parseJsonOrValue([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// utf8BytesWithin
// ---------------------------------------------------------------------------

describe("utf8BytesWithin", () => {
  it("counts ASCII bytes", () => {
    expect(utf8BytesWithin("hello", 100)).toBe(5)
    expect(utf8BytesWithin("", 100)).toBe(0)
  })

  it("counts multi-byte characters", () => {
    // é is 2 bytes in UTF-8
    expect(utf8BytesWithin("é", 100)).toBe(2)
    // ☺ is 3 bytes
    expect(utf8BytesWithin("☺", 100)).toBe(3)
    // 𠀀 is 4 bytes (surrogate pair / code point > 0xFFFF)
    expect(utf8BytesWithin("𠀀", 100)).toBe(4)
  })

  it("returns undefined when bytes exceed maximum", () => {
    expect(utf8BytesWithin("hello", 4)).toBeUndefined()
    expect(utf8BytesWithin("hi", 1)).toBeUndefined()
  })

  it("returns the count exactly at the maximum boundary", () => {
    // "abc" = 3 bytes; maximum = 3 should succeed
    expect(utf8BytesWithin("abc", 3)).toBe(3)
    // maximum = 2 should fail
    expect(utf8BytesWithin("abc", 2)).toBeUndefined()
  })

  it("returns 0 for an empty string with any maximum", () => {
    expect(utf8BytesWithin("", 0)).toBe(0)
    expect(utf8BytesWithin("", 1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// boundedGraphBytes
// ---------------------------------------------------------------------------

describe("boundedGraphBytes", () => {
  // Accounting constants (mirrors native.ts to pin the byte rules):
  //   null/boolean/number   → 32 bytes flat
  //   container ({} or [])  → +2 bytes
  //   array element         → +1 byte  (plus the element itself)
  //   object key "k"        → +jsonStringBytes("k") + 2  (for ": ")

  it("returns exactly 32 for null", () => {
    expect(boundedGraphBytes(null, 1_000)).toBe(32)
  })

  it("returns exactly 32 for a boolean", () => {
    expect(boundedGraphBytes(true, 1_000)).toBe(32)
  })

  it("returns exactly 32 for a number", () => {
    expect(boundedGraphBytes(0, 1_000)).toBe(32)
  })

  it("returns exact count for a shallow object with one null value", () => {
    // {}: 2 container; key "a": "a" = 3 bytes + 2 = 5; null: 32 → total 39
    expect(boundedGraphBytes({ a: null }, 1_000)).toBe(39)
  })

  it("returns exact count for a single-element array", () => {
    // []: 2 container; element slot: 1; null: 32 → total 35
    expect(boundedGraphBytes([null], 1_000)).toBe(35)
  })

  it("returns exact count for a three-element array of numbers", () => {
    // []: 2; 3*(1+32) = 99 → total 101
    expect(boundedGraphBytes([1, 2, 3], 1_000)).toBe(101)
  })

  it("returns a positive count for simple primitives", () => {
    const n = boundedGraphBytes(null, 1_000)
    expect(typeof n).toBe("number")
    expect((n ?? 0) > 0).toBe(true)
  })

  it("returns a count for a shallow object", () => {
    const val = { a: "hello" }
    const n = boundedGraphBytes(val, 1_000)
    expect(typeof n).toBe("number")
    expect((n ?? 0) > 0).toBe(true)
  })

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

  it("counts a JSON array correctly", () => {
    const arr = [1, 2, 3]
    const n = boundedGraphBytes(arr, 1_000)
    expect(typeof n).toBe("number")
    expect((n ?? 0) > 0).toBe(true)
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
  it("accepts a printable ASCII string within maxLength", () => {
    expect(nativeId("live-session-abc", 256)).toBe("live-session-abc")
    expect(nativeId("a", 1)).toBe("a")
  })

  it("rejects empty string", () => {
    expect(nativeId("", 256)).toBeUndefined()
  })

  it("rejects strings longer than maxLength", () => {
    const long = "a".repeat(257)
    expect(nativeId(long, 256)).toBeUndefined()
    expect(nativeId("a".repeat(513), 512)).toBeUndefined()
  })

  it("accepts a string exactly at maxLength", () => {
    const exact = "a".repeat(256)
    expect(nativeId(exact, 256)).toBe(exact)
  })

  it("rejects strings with control characters (code < 32)", () => {
    expect(nativeId("hello\nworld", 256)).toBeUndefined()
    expect(nativeId("tab\there", 256)).toBeUndefined()
    expect(nativeId("\x00null", 256)).toBeUndefined()
  })

  it("rejects strings with DEL (code 127)", () => {
    expect(nativeId("del\x7fchar", 256)).toBeUndefined()
  })

  it("rejects non-string values", () => {
    expect(nativeId(null, 256)).toBeUndefined()
    expect(nativeId(42, 256)).toBeUndefined()
    expect(nativeId({}, 256)).toBeUndefined()
    expect(nativeId(undefined, 256)).toBeUndefined()
  })

  it("uses maxLength parameter: 512 accepts what 256 rejects", () => {
    const s = "a".repeat(300)
    expect(nativeId(s, 256)).toBeUndefined()
    expect(nativeId(s, 512)).toBe(s)
  })
})

// ---------------------------------------------------------------------------
// timestamp
// ---------------------------------------------------------------------------

describe("timestamp", () => {
  it("converts epoch-seconds to ISO string", () => {
    // 1 second after epoch
    expect(timestamp(1)).toBe("1970-01-01T00:00:01.000Z")
  })

  it("converts epoch-milliseconds to ISO string", () => {
    // 10_000_000_001 ms = well into epoch-ms territory
    expect(timestamp(10_000_000_001)).toBe(
      new Date(10_000_000_001).toISOString()
    )
  })

  it("treats values < 10_000_000_000 as epoch-seconds", () => {
    const sec = 1_700_000_000
    expect(timestamp(sec)).toBe(new Date(sec * 1000).toISOString())
  })

  it("treats values >= 10_000_000_000 as epoch-milliseconds", () => {
    const ms = 10_000_000_000
    expect(timestamp(ms)).toBe(new Date(ms).toISOString())
  })

  it("falls back to epoch for zero", () => {
    expect(timestamp(0)).toBe("1970-01-01T00:00:00.000Z")
  })

  it("falls back to epoch for negative values", () => {
    expect(timestamp(-1)).toBe("1970-01-01T00:00:00.000Z")
  })

  it("falls back to epoch for non-numeric values", () => {
    expect(timestamp(null)).toBe("1970-01-01T00:00:00.000Z")
    expect(timestamp(undefined)).toBe("1970-01-01T00:00:00.000Z")
    expect(timestamp("not-a-number")).toBe("1970-01-01T00:00:00.000Z")
    expect(timestamp({})).toBe("1970-01-01T00:00:00.000Z")
  })

  it("parses a numeric string as epoch-seconds", () => {
    expect(timestamp("1000")).toBe(new Date(1000 * 1000).toISOString())
  })
})
