import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const VERSION = 1
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16
const MAX_TOKEN_LENGTH = 4_096
const MAX_CLAIM_BYTES = 2_048
const MAX_KEY_ID_LENGTH = 64
const MAX_IDENTIFIER_LENGTH = 256
const MAX_SCOPE_LENGTH = 512
const MAX_CURSOR_LIFETIME_SECONDS = 3_600
const SCOPE_VERSION = "ws1"
const CURSOR_AAD = Buffer.from(
  "aos-ui reconnect cursor|/api/aos/v1/events|aos-events-v1",
  "utf8"
)

export type ReconnectCursorLane = "operator" | "guest"

/**
 * Values that must still be true when a reconnect is attempted. The caller
 * obtains the authoritative event position after this binding has been checked;
 * cursors deliberately carry no native position and are never authorization.
 */
export interface ReconnectCursorBinding {
  deploymentId: string
  lane: ReconnectCursorLane
  principalId?: string
  invitationId?: string
  authorizationRevision: string
  scope: string
  agentId: string
  sessionId: string
  bootEpoch: string
  streamId: string
}

export interface ReconnectCursorSealClaims extends ReconnectCursorBinding {
  iat: number
  exp: number
}

export interface ReconnectCursorClaims extends ReconnectCursorSealClaims {
  version: 1
  keyId: string
}

export interface ReconnectCursorCodecOptions {
  activeKeyId: string
  keys: Readonly<Record<string, Uint8Array>>
  /** Unix time in seconds. Supplying this is useful only for deterministic tests. */
  now?: () => number
}

export interface ReconnectCursorCodec {
  seal(claims: ReconnectCursorSealClaims): string
  /** Returns null for every invalid untrusted token or binding. */
  open(
    token: string,
    expected: ReconnectCursorBinding
  ): ReconnectCursorClaims | null
}

/**
 * Creates the stateless envelope used only to bind an events reconnect to its
 * already-authorized request. Endpoint and protocol are authenticated as fixed
 * AEAD additional data, and every identity-bearing claim is encrypted.
 */
export function createReconnectCursorCodec(
  options: ReconnectCursorCodecOptions
): ReconnectCursorCodec {
  const activeKeyId = validKeyId(options.activeKeyId)
  const keys = validatedKeys(options.keys)
  const activeKey = activeKeyId === null ? undefined : keys.get(activeKeyId)
  if (activeKeyId === null || activeKey === undefined)
    throw new Error("Invalid reconnect cursor configuration")

  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))

  return {
    seal(input) {
      const claims = claimsForSeal(input, activeKeyId)
      if (claims === null) throw new Error("Invalid reconnect cursor")

      const plaintext = Buffer.from(canonicalClaimsJson(claims), "utf8")
      if (plaintext.length > MAX_CLAIM_BYTES)
        throw new Error("Invalid reconnect cursor")

      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv("aes-256-gcm", activeKey, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      })
      cipher.setAAD(CURSOR_AAD)
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ])
      const tag = cipher.getAuthTag()

      return [
        `v${VERSION}`,
        activeKeyId,
        encodeBase64Url(nonce),
        encodeBase64Url(ciphertext),
        encodeBase64Url(tag),
      ].join(".")
    },

    open(token, expected) {
      if (!validBinding(expected) || !isBoundedToken(token)) return null

      try {
        const parts = token.split(".")
        if (parts.length !== 5 || parts[0] !== `v${VERSION}`) return null

        const keyId = validKeyId(parts[1])
        const nonce = decodeCanonicalBase64Url(parts[2], NONCE_BYTES)
        const ciphertext = decodeCanonicalBase64Url(parts[3])
        const tag = decodeCanonicalBase64Url(parts[4], AUTH_TAG_BYTES)
        if (
          keyId === null ||
          nonce === null ||
          ciphertext === null ||
          tag === null ||
          ciphertext.length === 0 ||
          ciphertext.length > MAX_CLAIM_BYTES
        )
          return null

        const key = keys.get(keyId)
        if (key === undefined) return null

        const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: AUTH_TAG_BYTES,
        })
        decipher.setAAD(CURSOR_AAD)
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ])
        if (plaintext.length > MAX_CLAIM_BYTES) return null

        const claims = parseCanonicalClaims(plaintext)
        if (
          claims === null ||
          claims.keyId !== keyId ||
          !sameBinding(claims, expected) ||
          expired(claims, now)
        )
          return null
        return claims
      } catch {
        return null
      }
    },
  }
}

function validatedKeys(input: Readonly<Record<string, Uint8Array>>) {
  const entries = Object.entries(input)
  if (entries.length === 0 || entries.length > 8)
    throw new Error("Invalid reconnect cursor configuration")

  const keys = new Map<string, Buffer>()
  for (const [keyId, key] of entries) {
    const valid = validKeyId(keyId)
    if (valid === null || !isByteArray(key) || key.byteLength !== 32)
      throw new Error("Invalid reconnect cursor configuration")
    keys.set(valid, Buffer.from(key))
  }
  return keys
}

function claimsForSeal(
  input: ReconnectCursorSealClaims,
  keyId: string
): ReconnectCursorClaims | null {
  if (
    !validBinding(input) ||
    !validTimestamp(input.iat) ||
    !validTimestamp(input.exp)
  )
    return null
  if (
    input.exp <= input.iat ||
    input.exp - input.iat > MAX_CURSOR_LIFETIME_SECONDS
  )
    return null
  return { version: VERSION, keyId, ...input }
}

function parseCanonicalClaims(plaintext: Buffer): ReconnectCursorClaims | null {
  let candidate: unknown
  try {
    candidate = JSON.parse(plaintext.toString("utf8"))
  } catch {
    return null
  }
  if (!isRecord(candidate) || !hasOnlyClaimKeys(candidate)) return null

  const claims = candidate as unknown as ReconnectCursorClaims
  if (
    claims.version !== VERSION ||
    validKeyId(claims.keyId) === null ||
    !validBinding(claims) ||
    !validTimestamp(claims.iat) ||
    !validTimestamp(claims.exp) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_CURSOR_LIFETIME_SECONDS
  )
    return null

  return canonicalClaimsJson(claims) === plaintext.toString("utf8")
    ? claims
    : null
}

function canonicalClaimsJson(claims: ReconnectCursorClaims) {
  return JSON.stringify({
    version: claims.version,
    keyId: claims.keyId,
    deploymentId: claims.deploymentId,
    lane: claims.lane,
    ...(claims.principalId === undefined
      ? {}
      : { principalId: claims.principalId }),
    ...(claims.invitationId === undefined
      ? {}
      : { invitationId: claims.invitationId }),
    authorizationRevision: claims.authorizationRevision,
    scope: claims.scope,
    agentId: claims.agentId,
    sessionId: claims.sessionId,
    bootEpoch: claims.bootEpoch,
    streamId: claims.streamId,
    iat: claims.iat,
    exp: claims.exp,
  })
}

function hasOnlyClaimKeys(value: Record<string, unknown>) {
  const keys = Object.keys(value)
  const permitted = new Set([
    "version",
    "keyId",
    "deploymentId",
    "lane",
    "principalId",
    "invitationId",
    "authorizationRevision",
    "scope",
    "agentId",
    "sessionId",
    "bootEpoch",
    "streamId",
    "iat",
    "exp",
  ])
  return keys.every((key) => permitted.has(key))
}

function validBinding(value: ReconnectCursorBinding): boolean {
  if (
    !isBoundedString(value.deploymentId, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedString(value.authorizationRevision, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedString(value.agentId, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedString(value.sessionId, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedString(value.bootEpoch, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedString(value.streamId, MAX_IDENTIFIER_LENGTH)
  )
    return false
  if (!isCanonicalScope(value.scope, value.agentId, value.sessionId))
    return false

  if (value.lane === "operator")
    return (
      isBoundedString(value.principalId, MAX_IDENTIFIER_LENGTH) &&
      value.invitationId === undefined
    )
  return (
    value.lane === "guest" &&
    value.principalId === undefined &&
    isBoundedString(value.invitationId, MAX_IDENTIFIER_LENGTH)
  )
}

/**
 * The canonical workspace/session scope is `ws1.<workspace>.<agent>.<session>`
 * where every component is canonical UTF-8 base64url. It removes delimiter and
 * percent-encoding aliases while binding the scope to the exact Session owner.
 */
function isCanonicalScope(
  scope: unknown,
  agentId: string,
  sessionId: string
): boolean {
  if (!isBoundedString(scope, MAX_SCOPE_LENGTH)) return false
  const [version, workspace, agent, session, ...remainder] = scope.split(".")
  if (
    version !== SCOPE_VERSION ||
    workspace === undefined ||
    agent === undefined ||
    session === undefined ||
    remainder.length > 0
  )
    return false

  const workspaceId = decodeCanonicalScopeComponent(workspace)
  const scopedAgentId = decodeCanonicalScopeComponent(agent)
  const scopedSessionId = decodeCanonicalScopeComponent(session)
  return (
    workspaceId !== null &&
    scopedAgentId === agentId &&
    scopedSessionId === sessionId
  )
}

function decodeCanonicalScopeComponent(value: string): string | null {
  const bytes = decodeCanonicalBase64Url(value)
  if (bytes === null) return null
  const decoded = bytes.toString("utf8")
  return isBoundedString(decoded, MAX_IDENTIFIER_LENGTH) &&
    Buffer.from(decoded, "utf8").equals(bytes)
    ? decoded
    : null
}

function sameBinding(
  claims: ReconnectCursorClaims,
  expected: ReconnectCursorBinding
) {
  return (
    claims.deploymentId === expected.deploymentId &&
    claims.lane === expected.lane &&
    claims.principalId === expected.principalId &&
    claims.invitationId === expected.invitationId &&
    claims.authorizationRevision === expected.authorizationRevision &&
    claims.scope === expected.scope &&
    claims.agentId === expected.agentId &&
    claims.sessionId === expected.sessionId &&
    claims.bootEpoch === expected.bootEpoch &&
    claims.streamId === expected.streamId
  )
}

function expired(claims: ReconnectCursorClaims, now: () => number) {
  const current = now()
  return !validTimestamp(current) || claims.exp <= current
}

function validTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 4_102_444_800
  )
}

function validKeyId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]+$/u.test(value) &&
    value.length <= MAX_KEY_ID_LENGTH
    ? value
    : null
}

function isBoundedString(
  value: unknown,
  maximumLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.normalize("NFC") &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH
  )
}

function encodeBase64Url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url")
}

function decodeCanonicalBase64Url(
  value: string,
  length?: number
): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null
  try {
    const decoded = Buffer.from(value, "base64url")
    if (
      decoded.length === 0 ||
      (length !== undefined && decoded.length !== length) ||
      encodeBase64Url(decoded) !== value
    )
      return null
    return decoded
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isByteArray(value: unknown): value is Uint8Array {
  return (
    Buffer.isBuffer(value) ||
    (ArrayBuffer.isView(value) &&
      "BYTES_PER_ELEMENT" in value &&
      value.BYTES_PER_ELEMENT === 1)
  )
}
