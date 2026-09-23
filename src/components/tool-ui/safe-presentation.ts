import { REDACTED, redactCredentials } from "@shared/credentials"

const UNAVAILABLE = "[Unserializable value]"
const TRUNCATED = "[Truncated]"
const CIRCULAR = "[Circular]"

const MAX_DEPTH = 6
const MAX_ENTRIES = 100
const MAX_STRING_LENGTH = 4_000
const MAX_BYTES = 24_000
const MAX_TITLE_LENGTH = 160
const textEncoder = new TextEncoder()

const sensitiveKey =
  /(?:api[-_]?key|auth(?:orization)?|credential|cookie|password|passwd|private[-_]?key|secret|set[-_]?cookie|token)/i

export type SafeToolPresentation = {
  text: string
  title: string
}

export function safeToolPresentation(value: unknown): SafeToolPresentation {
  const sanitized = sanitize(value, new WeakSet(), 0)
  const text = boundedJson(sanitized)

  return { text, title: titleFrom(sanitized) }
}

/** Redacted, bounded text shown as it reads, never re-encoded as JSON. */
export function safeToolText(value: string): string {
  return safeString(value)
}

/** Returns a redacted, bounded primitive from an object without reading raw args. */
export function safeToolDisplayValue(
  value: unknown,
  keys: readonly string[],
  fallback: string
) {
  const sanitized = sanitize(value, new WeakSet(), 0)
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return fallback
  }

  for (const key of keys) {
    const candidate = (sanitized as Record<string, unknown>)[key]
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim()
  }
  return fallback
}

function sanitize(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (typeof value === "string") return safeString(value)
  if (typeof value === "bigint") return `${value}n`
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value
  }
  if (typeof value === "undefined") return "[undefined]"
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`
  }
  if (depth >= MAX_DEPTH) return TRUNCATED
  if (typeof value !== "object") return UNAVAILABLE
  if (seen.has(value)) return CIRCULAR
  seen.add(value)

  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (
      let index = 0;
      index < Math.min(value.length, MAX_ENTRIES);
      index += 1
    ) {
      result.push(sanitize(readArrayItem(value, index), seen, depth + 1))
    }
    if (value.length > MAX_ENTRIES) result.push(TRUNCATED)
    return result
  }

  const result: Record<string, unknown> = {}
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return UNAVAILABLE
  }

  for (const key of keys.slice(0, MAX_ENTRIES)) {
    result[key] = sensitiveKey.test(key)
      ? REDACTED
      : sanitize(readProperty(value, key), seen, depth + 1)
  }
  if (keys.length > MAX_ENTRIES) result[TRUNCATED] = TRUNCATED
  return result
}

function readArrayItem(value: unknown[], index: number): unknown {
  try {
    return value[index]
  } catch {
    return UNAVAILABLE
  }
}

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    return UNAVAILABLE
  }
}

function safeString(value: string) {
  const redacted = redactCredentials(value)
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`
    : redacted
}

function boundedJson(value: unknown) {
  try {
    const text = JSON.stringify(value, null, 2) ?? UNAVAILABLE
    if (textEncoder.encode(text).byteLength <= MAX_BYTES) return text

    const suffix = `\n${TRUNCATED}`
    return `${truncateUtf8(text, MAX_BYTES - textEncoder.encode(suffix).byteLength)}${suffix}`
  } catch {
    return UNAVAILABLE
  }
}

function truncateUtf8(value: string, maxBytes: number) {
  let length = 0
  let bytes = 0

  for (const character of value) {
    const characterBytes = textEncoder.encode(character).byteLength
    if (bytes + characterBytes > maxBytes) break
    bytes += characterBytes
    length += character.length
  }

  return value.slice(0, length)
}

function titleFrom(value: unknown) {
  if (typeof value === "string") return titleText(value)
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["title", "name", "action", "toolName"]) {
      const candidate = (value as Record<string, unknown>)[key]
      if (typeof candidate === "string" && candidate !== REDACTED)
        return titleText(candidate)
    }
  }
  return "Tool output"
}

function titleText(value: string) {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? "Tool output"
  return firstLine.length > MAX_TITLE_LENGTH
    ? `${firstLine.slice(0, MAX_TITLE_LENGTH)}…`
    : firstLine || "Tool output"
}
