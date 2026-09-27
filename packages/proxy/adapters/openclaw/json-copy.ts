import type { JsonValue } from "../json-value"

const MAX_JSON_BYTES = 262_144
const encoder = new TextEncoder()

/**
 * A native value as JSON, or `fallback` when it does not serialize within
 * 256 KiB of UTF-8. Live events and replayed history share this one bound.
 */
export function safeJson(value: unknown, fallback = "{}") {
  try {
    const json = JSON.stringify(value)
    return typeof json === "string" &&
      encoder.encode(json).byteLength <= MAX_JSON_BYTES
      ? json
      : fallback
  } catch {
    return fallback
  }
}

/** A JSON copy of a native value within the same bound, or `undefined`. */
export function safeClone(value: unknown): JsonValue | undefined {
  const json = safeJson(value, "")
  if (!json) return undefined
  try {
    return JSON.parse(json) as JsonValue
  } catch {
    return undefined
  }
}
