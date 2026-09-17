import { parseJsonOrValue } from "./native"

export type HermesPublicJsonValue =
  | null
  | boolean
  | number
  | string
  | HermesPublicJsonValue[]
  | { [key: string]: HermesPublicJsonValue }

export type HermesPublicJsonRecord = Record<string, HermesPublicJsonValue>

const REDACTED = "[REDACTED]"
const TRUNCATED = "[Truncated]"
const MAX_DEPTH = 6
const MAX_ENTRIES = 64
const MAX_KEY_LENGTH = 128
const MAX_STRING_LENGTH = 4_000
const MAX_TOTAL_STRING_LENGTH = 8_000

const SAFE_CREDENTIAL_LIKE_KEYS = new Set([
  "accesskeyrotation",
  "authmode",
  "authorizationmode",
  "oauth",
  "oauthmode",
  "secretary",
  "tokencount",
  "tokenlimit",
  "tokenusage",
])
const CREDENTIAL_WRAPPERS = new Set([
  "b64",
  "base64",
  "ciphertext",
  "digest",
  "encoded",
  "encrypted",
  "file",
  "hash",
  "hashed",
  "path",
  "salt",
  "sha256",
  "value",
])
const credentialValue =
  /(?:\b(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credential|password|secret|token)\s*[=:]\s*\S+|\b(?:basic|bearer)\s+\S+|\b(?:gh[opsur]_\w+|sk-[\w-]+|xox[baprs]-\w+|eyJ[\w-]+\.[\w-]+\.[\w-]+))/iu

type ProjectionState = {
  entries: number
  stringLength: number
  seen: WeakSet<object>
}

function normalizedKey(key: string) {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase()
}

function credentialToolKey(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean)
  const normalized = words.join("")
  if (SAFE_CREDENTIAL_LIKE_KEYS.has(normalized)) return false
  while (words.length > 1 && CREDENTIAL_WRAPPERS.has(words.at(-1) ?? ""))
    words.pop()
  const core = words.join("")
  const credentialTerms = [
    "pwd",
    "pass",
    "passcode",
    "password",
    "passwd",
    "passphrase",
    "privatekey",
    "secret",
    "secretkey",
    "token",
    "apikey",
    "accesskey",
    "accesskeyid",
    "auth",
    "authorization",
    "cookie",
    "cookiejar",
    "credential",
    "credentials",
  ]
  const prefix = words.slice(0, 2).join("")
  const suffix = words.slice(-2).join("")
  return (
    core === "npmconfiguserconfig" ||
    credentialTerms.some(
      (term) =>
        core === term ||
        core.endsWith(term) ||
        words[0] === term ||
        prefix === term ||
        suffix === term
    )
  )
}

function providerPrivateKey(key: string) {
  const normalized = normalizedKey(key)
  return (
    normalized.endsWith("sessionid") ||
    normalized.endsWith("liveid") ||
    normalized.endsWith("metadata") ||
    normalized === "nativeposition" ||
    normalized === "providermetadata"
  )
}

function stringContainsCredential(value: string) {
  if (credentialValue.test(value)) return true
  const assignments = value.matchAll(
    /(?:^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*)\s*=/gu
  )
  for (const match of assignments) {
    if (credentialToolKey(match[1] ?? "")) return true
  }
  return false
}

function projectString(value: string, state: ProjectionState) {
  if (stringContainsCredential(value)) return REDACTED
  const available = Math.max(
    0,
    Math.min(MAX_STRING_LENGTH, MAX_TOTAL_STRING_LENGTH - state.stringLength)
  )
  if (available === 0) return TRUNCATED
  const projected = truncateString(value, available)
  state.stringLength += projected.length
  return projected
}

function truncateString(value: string, maximum: number) {
  if (value.length <= maximum) return value
  const contentMaximum = Math.max(0, maximum - TRUNCATED.length)
  let content = ""
  for (const character of value) {
    if (content.length + character.length > contentMaximum) break
    content += character
  }
  return `${content}${TRUNCATED}`
}

function projectValue(
  value: unknown,
  state: ProjectionState,
  depth: number
): HermesPublicJsonValue | undefined {
  if (typeof value === "string") return projectString(value, state)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (depth >= MAX_DEPTH || state.entries >= MAX_ENTRIES) return TRUNCATED
  if (typeof value !== "object") return undefined
  if (state.seen.has(value)) return TRUNCATED
  state.seen.add(value)

  if (Array.isArray(value)) {
    const result: HermesPublicJsonValue[] = []
    for (const item of value) {
      if (state.entries >= MAX_ENTRIES) {
        result.push(TRUNCATED)
        break
      }
      state.entries += 1
      const projected = projectValue(item, state, depth + 1)
      if (projected !== undefined) result.push(projected)
    }
    return result
  }

  const result: HermesPublicJsonRecord = {}
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return undefined
  }
  for (const key of keys) {
    if (state.entries >= MAX_ENTRIES) {
      result[TRUNCATED] = TRUNCATED
      break
    }
    if (key.length > MAX_KEY_LENGTH || providerPrivateKey(key)) continue
    state.entries += 1
    if (credentialToolKey(key)) {
      result[key] = REDACTED
      continue
    }
    let item: unknown
    try {
      item = Reflect.get(value, key)
    } catch {
      continue
    }
    const projected = projectValue(item, state, depth + 1)
    if (projected !== undefined) result[key] = projected
  }
  return result
}

/**
 * Hermes integrations do not consistently set `is_error` on durable tool
 * rows. Preserve an explicit native flag, then recognize the small set of
 * result envelopes that unambiguously represent failure.
 */
export function hermesToolResultIsError(
  value: unknown,
  nativeIsError = false
): boolean {
  if (nativeIsError) return true
  const parsed = parseJsonOrValue(value)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false
  const result = parsed as Record<string, unknown>
  if (result.success === false || result.ok === false) return true
  return (
    typeof result.status === "string" &&
    ["error", "failed", "failure"].includes(result.status.toLowerCase())
  )
}

function project(value: unknown) {
  return projectValue(
    parseJsonOrValue(value),
    {
      entries: 0,
      stringLength: 0,
      seen: new WeakSet(),
    },
    0
  )
}

/**
 * Projects operator-visible tool arguments without carrying provider session
 * metadata or credentials into the browser. Guest projections discard tool
 * calls before reaching this boundary.
 */
export function projectHermesToolArgs(value: unknown): HermesPublicJsonRecord {
  const projected = project(value)
  return projected && typeof projected === "object" && !Array.isArray(projected)
    ? projected
    : {}
}

/** Projects the inspectable result recorded for an operator-visible tool call. */
export function projectHermesToolResult(
  value: unknown,
  isError = false
): HermesPublicJsonValue {
  const projected = project(value)
  return projected ?? { status: isError ? "failed" : "completed" }
}
