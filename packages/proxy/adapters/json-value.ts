/**
 * The bounded public copy of a native JSON value that every adapter shares.
 *
 * A native payload is provider data a browser reads, so its copy is bounded
 * before it leaves the adapter: nesting past `MAX_DEPTH` is dropped, each
 * array and object keeps its first `MAX_ENTRIES` entries, a string longer than
 * `MAX_STRING_LENGTH` is dropped, a key naming a credential or provider-private
 * data is dropped with its value, and a copy that still serializes past
 * `MAX_JSON_LENGTH` is no copy at all.
 */

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const MAX_DEPTH = 8
const MAX_ENTRIES = 100
const MAX_STRING_LENGTH = 4_000
const MAX_JSON_LENGTH = 262_144
const PRIVATE_KEY = /(?:credential|metadata|password|path|secret|token|url)$/iu

function project(value: unknown, depth: number): JsonValue | undefined {
  if (depth > MAX_DEPTH) return undefined
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (typeof value === "string")
    return value.length <= MAX_STRING_LENGTH ? value : undefined
  if (Array.isArray(value))
    return value.slice(0, MAX_ENTRIES).flatMap((item) => {
      const projected = project(item, depth + 1)
      return projected === undefined ? [] : [projected]
    })
  if (typeof value !== "object") return undefined
  const result: { [key: string]: JsonValue } = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    if (PRIVATE_KEY.test(key)) continue
    const projected = project(item, depth + 1)
    if (projected !== undefined) result[key] = projected
  }
  return result
}

/** A bounded public copy of a native value, or `undefined` when it has none. */
export function publicJsonValue(value: unknown): JsonValue | undefined {
  const projected = project(value, 0)
  return projected !== undefined &&
    JSON.stringify(projected).length <= MAX_JSON_LENGTH
    ? projected
    : undefined
}
