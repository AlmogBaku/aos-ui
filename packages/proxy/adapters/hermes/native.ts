/**
 * Shared pure helpers used by multiple Hermes adapter modules.
 * All functions are stateless; callers that need a different failure semantic
 * must provide a local wrapper rather than changing these shared shapes.
 */

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to JSON.parse a string value; non-strings are returned unchanged.
 * On parse failure returns `undefined`.  Callers that need the raw string on
 * failure should use `parseJsonOrValue` instead.
 */
export function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

/**
 * Attempt to JSON.parse a string value; non-strings are returned unchanged.
 * On parse failure returns the original string unchanged.  Use instead of
 * `parseJson` when the raw string is a valid fallback (e.g. tool-data rows,
 * workspace context fields).  Callers that need `undefined` on failure should
 * use `parseJson` instead.
 */
export function parseJsonOrValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Return `value` as a trimmed non-empty string, or `undefined`. The one shared
 * shape for reading an optional native text field.
 */
export function trimmedText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

// ---------------------------------------------------------------------------
// Redaction predicates
// ---------------------------------------------------------------------------

const CREDENTIAL_VALUE =
  /(?:\b(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credential|password|secret|token)\s*[=:]\s*\S+|\b(?:basic|bearer)\s+\S+|\b(?:gh[opsur]_\w+|sk-[\w-]+|xox[baprs]-\w+|eyJ[\w-]+\.[\w-]+\.[\w-]+))/iu
const PRIVATE_LOCATION_VALUE =
  /(?:^|[\s("'=])(?:\/(?:etc|home|root|srv|tmp|var)\/|[A-Za-z]:\\|file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s]*(?:hermes|internal|\.local))(?:[/:]|$))/iu

/** True when a native string carries a credential-shaped secret. */
export function containsCredentialValue(value: string) {
  return CREDENTIAL_VALUE.test(value)
}

/**
 * True when a native string looks like a credential or a private filesystem or
 * internal-network location. The one rule deciding what may leave the adapter,
 * shared by tool projection and artifact receipts.
 */
export function containsPrivateValue(value: string) {
  return containsCredentialValue(value) || PRIVATE_LOCATION_VALUE.test(value)
}

// ---------------------------------------------------------------------------
// UTF-8 byte helpers
// ---------------------------------------------------------------------------

function utf8CodePointBytes(codePoint: number): number {
  return codePoint <= 0x7f
    ? 1
    : codePoint <= 0x7ff
      ? 2
      : codePoint <= 0xffff
        ? 3
        : 4
}

/**
 * Count the UTF-8 encoded byte length of `value`, stopping early and
 * returning `undefined` as soon as the running total exceeds `maximum`.
 * Returns the exact byte count when the string fits within `maximum`.
 */
export function utf8BytesWithin(
  value: string,
  maximum: number
): number | undefined {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    bytes += utf8CodePointBytes(codePoint)
    if (bytes > maximum) return undefined
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Bounded JSON shape
// ---------------------------------------------------------------------------

/** Maximum accepted object/array nesting depth of a decoded native payload. */
export const MAX_NATIVE_JSON_DEPTH = 32
/** Maximum accepted node count of a decoded native payload. */
export const MAX_NATIVE_JSON_NODES = 200_000

/**
 * True when `value` stays within `MAX_NATIVE_JSON_DEPTH` nesting levels and
 * `MAX_NATIVE_JSON_NODES` total nodes. Shared by the socket wire guard
 * (`gateway-socket.ts`) and the bounded REST reader (`http.ts`) so a decoded
 * frame and a decoded body obey one bound.
 */
export function boundedJsonShape(value: unknown) {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_NATIVE_JSON_NODES || current.depth > MAX_NATIVE_JSON_DEPTH)
      return false
    if (typeof current.value !== "object" || current.value === null) continue
    for (const child of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value))
      pending.push({ value: child, depth: current.depth + 1 })
  }
  return true
}

// ---------------------------------------------------------------------------
// Bounded JSON-graph walk
// ---------------------------------------------------------------------------

/** Maximum object/array nesting depth accepted by `boundedGraphBytes`. */
export const MAX_GRAPH_DEPTH = 12
/** Maximum total object/array entry count accepted by `boundedGraphBytes`. */
export const MAX_GRAPH_ENTRIES = 1_024

function jsonStringBytesWithin(
  value: string,
  maximum: number
): number | undefined {
  // Opening and closing double-quote
  let bytes = 2
  if (bytes > maximum) return undefined
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    bytes +=
      character === '"' || character === "\\"
        ? 2
        : codePoint < 0x20
          ? character === "\b" ||
            character === "\f" ||
            character === "\n" ||
            character === "\r" ||
            character === "\t"
            ? 2
            : 6
          : codePoint >= 0xd800 && codePoint <= 0xdfff
            ? 6
            : utf8CodePointBytes(codePoint)
    if (bytes > maximum) return undefined
  }
  return bytes
}

/**
 * Walk an arbitrary JSON-serialisable value and return its approximate
 * serialised byte count, or `undefined` if the value exceeds `maximum` bytes,
 * `MAX_GRAPH_DEPTH` nesting levels, or `MAX_GRAPH_ENTRIES` total entries.
 * Circular references also return `undefined`.
 */
export function boundedGraphBytes(
  value: unknown,
  maximum: number
): number | undefined {
  const seen = new WeakSet<object>()
  let bytes = 0
  let entries = 0

  const addBytes = (amount: number): boolean => {
    bytes += amount
    return bytes <= maximum
  }

  const visit = (current: unknown, depth: number): boolean => {
    if (depth > MAX_GRAPH_DEPTH || entries > MAX_GRAPH_ENTRIES) return false
    if (typeof current === "string") {
      const size = jsonStringBytesWithin(current, maximum - bytes)
      return size !== undefined && addBytes(size)
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "number"
    )
      return addBytes(32)
    if (typeof current !== "object") return false
    if (seen.has(current)) return false
    seen.add(current)
    if (!addBytes(2)) return false

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        entries += 1
        if (entries > MAX_GRAPH_ENTRIES || !addBytes(1)) return false
        let item: unknown
        try {
          item = current[index]
        } catch {
          return false
        }
        if (!visit(item, depth + 1)) return false
      }
      return true
    }

    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue
      entries += 1
      if (entries > MAX_GRAPH_ENTRIES) return false
      const keyBytes = jsonStringBytesWithin(key, maximum - bytes)
      if (keyBytes === undefined || !addBytes(keyBytes + 2)) return false
      let item: unknown
      try {
        item = (current as Record<string, unknown>)[key]
      } catch {
        return false
      }
      if (!visit(item, depth + 1)) return false
    }
    return true
  }

  return visit(value, 0) ? bytes : undefined
}

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

/**
 * Return `value` as a validated native identifier string, or `undefined` if
 * it fails validation.  A valid id is a non-empty string whose length does not
 * exceed `maxLength` characters and contains no C0 control characters (< 32)
 * and no DEL (127); non-ASCII code points are accepted.
 *
 * Pass the appropriate max for the identifier type:
 *   - live session ids: 256  (see adapter.ts `validLiveSessionId`)
 *   - general native ids: 512 (see run.ts `stableNativeId`)
 */
export function nativeId(
  value: unknown,
  maxLength: number
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  )
    return undefined
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return undefined
  }
  return value
}

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

/**
 * Convert a raw Hermes timestamp to an ISO-8601 string.
 *
 * Hermes stores timestamps as either epoch-seconds (values < 10_000_000_000)
 * or epoch-milliseconds.  Invalid values (non-finite, zero, negative) fall
 * back to `new Date(fallbackMs).toISOString()` (default: Unix epoch).
 *
 * Pass `fallbackMs = index` from `history.ts` row builders so that rows
 * without a timestamp sort in insertion order rather than all collapsing to
 * the epoch.
 */
export function timestamp(value: unknown, fallbackMs = 0): string {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0
    ? new Date(
        numeric < 10_000_000_000 ? numeric * 1000 : numeric
      ).toISOString()
    : new Date(fallbackMs).toISOString()
}

// ---------------------------------------------------------------------------
// Durable Session identity
// ---------------------------------------------------------------------------

/**
 * The one map key for a durable Agent/Session pair. The separator cannot occur
 * in a native identifier, so two distinct pairs never collide.
 */
export function sessionKey(scope: { agentId: string; sessionId: string }) {
  return `${scope.agentId}\u0000${scope.sessionId}`
}

// ---------------------------------------------------------------------------
// Log redaction
// ---------------------------------------------------------------------------

/**
 * The only error detail any Hermes module may log: never a message, path, URL
 * or token. Shared by the gateway and the attachment registry so one redaction
 * semantic covers every native failure log.
 */
export function publicReason(error: unknown) {
  return error instanceof Error ? error.name : "unknown"
}
