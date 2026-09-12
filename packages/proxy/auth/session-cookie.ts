import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import type { AosSessionIssuer } from "./oidc"

const COOKIE_NAME = "__Host-aos-session"
const COOKIE_VERSION = "v1"
const MAX_COOKIE_HEADER_BYTES = 8_192
const MAX_CIPHERTEXT_BYTES = 2_048
const MAX_CLAIMS_BYTES = 1_024
const NONCE_BYTES = 12
const TAG_BYTES = 16
const SESSION_ID_BYTES = 32

export type OperatorSession = {
  principalId: string
  sessionId: string
  issuedAt: number
  expiresAt: number
}

export type OperatorSessionCookieKey = {
  id: string
  secret: Uint8Array
}

export type OperatorSessionCookieOptions = {
  deploymentId: string
  keys: readonly OperatorSessionCookieKey[]
  now?: () => number
  ttlSeconds?: number
  clockSkewSeconds?: number
}

export type OperatorSessionCookie = AosSessionIssuer<OperatorSession> & {
  verify(cookieHeader: string | null): OperatorSession | undefined
  clear(): string
}

type EntropySource = (size: number) => Uint8Array

type Claims = {
  v: 1
  k: string
  d: string
  p: string
  i: number
  n: number
  e: number
  j: string
}

export class OperatorSessionCookieError extends Error {
  constructor() {
    super("Invalid operator session cookie configuration")
    this.name = "OperatorSessionCookieError"
  }
}

function validIdentifier(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  )
}

function validPrincipalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  )
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value)
}

function validUnixSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 4_102_444_800
  )
}

function base64url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url")
}

function decodeBase64url(
  value: string,
  minimumBytes: number,
  maximumBytes: number
): Buffer | undefined {
  if (
    value.length === 0 ||
    value.length > maximumBytes * 2 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return undefined
  try {
    const decoded = Buffer.from(value, "base64url")
    if (
      decoded.byteLength < minimumBytes ||
      decoded.byteLength > maximumBytes ||
      decoded.toString("base64url") !== value
    )
      return undefined
    return decoded
  } catch {
    return undefined
  }
}

function cookieValue(cookieHeader: string | null): string | undefined {
  if (!cookieHeader || cookieHeader.length > MAX_COOKIE_HEADER_BYTES)
    return undefined
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`))
    .map((part) => part.slice(COOKIE_NAME.length + 1))
  return values.length === 1 ? values[0] : undefined
}

function cookieAttributes(value: string, maxAge: number) {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`
}

function associatedData(keyId: string) {
  return `aos.operator-session.${COOKIE_VERSION}\u0000${keyId}`
}

function canonicalClaims(value: unknown): Claims | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  const record = value as Record<string, unknown>
  if (
    record.v !== 1 ||
    !validIdentifier(record.k, 32) ||
    !validIdentifier(record.d, 128) ||
    !validPrincipalId(record.p) ||
    !validUnixSeconds(record.i) ||
    !validUnixSeconds(record.n) ||
    !validUnixSeconds(record.e) ||
    !validSessionId(record.j)
  )
    return undefined
  const claims: Claims = {
    v: 1,
    k: record.k,
    d: record.d,
    p: record.p,
    i: record.i,
    n: record.n,
    e: record.e,
    j: record.j,
  }
  return claims
}

function secureRandom(source: EntropySource, size: number): Uint8Array {
  try {
    const value = source(size)
    if (!(value instanceof Uint8Array) || value.byteLength !== size)
      throw new OperatorSessionCookieError()
    return value
  } catch (error) {
    if (error instanceof OperatorSessionCookieError) throw error
    throw new OperatorSessionCookieError()
  }
}

function parseOptions(options: OperatorSessionCookieOptions) {
  const ttlSeconds = options.ttlSeconds ?? 900
  const clockSkewSeconds = options.clockSkewSeconds ?? 10
  if (
    !validIdentifier(options.deploymentId, 128) ||
    !Array.isArray(options.keys) ||
    options.keys.length < 1 ||
    options.keys.length > 2 ||
    options.keys.some(
      (key) =>
        !validIdentifier(key.id, 32) ||
        !(key.secret instanceof Uint8Array) ||
        key.secret.byteLength !== 32
    ) ||
    new Set(options.keys.map((key) => key.id)).size !== options.keys.length ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 86_400 ||
    !Number.isInteger(clockSkewSeconds) ||
    clockSkewSeconds < 0 ||
    clockSkewSeconds > 60
  )
    throw new OperatorSessionCookieError()
  return {
    deploymentId: options.deploymentId,
    keys: options.keys,
    ttlSeconds,
    clockSkewSeconds,
    now: options.now ?? Date.now,
  }
}

function nowSeconds(clock: () => number) {
  const value = clock()
  if (!Number.isSafeInteger(value) || value < 0)
    throw new OperatorSessionCookieError()
  const seconds = Math.floor(value / 1_000)
  if (!validUnixSeconds(seconds)) throw new OperatorSessionCookieError()
  return seconds
}

function decrypt(
  token: string,
  keys: readonly OperatorSessionCookieKey[]
): { claims: Claims; plaintext: string } | undefined {
  const segments = token.split(".")
  if (segments.length !== 5 || segments[0] !== COOKIE_VERSION) return undefined
  const keyId = segments[1]
  if (!validIdentifier(keyId, 32)) return undefined
  const key = keys.find((candidate) => candidate.id === keyId)
  if (!key) return undefined
  const nonce = decodeBase64url(segments[2], NONCE_BYTES, NONCE_BYTES)
  const ciphertext = decodeBase64url(segments[3], 1, MAX_CIPHERTEXT_BYTES)
  const tag = decodeBase64url(segments[4], TAG_BYTES, TAG_BYTES)
  if (!nonce || !ciphertext || !tag) return undefined
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.secret, nonce)
    decipher.setAAD(Buffer.from(associatedData(keyId), "utf8"))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
    if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_CLAIMS_BYTES)
      return undefined
    const text = plaintext.toString("utf8")
    const claims = canonicalClaims(JSON.parse(text) as unknown)
    if (!claims || JSON.stringify(claims) !== text) return undefined
    return { claims, plaintext: text }
  } catch {
    return undefined
  }
}

function createOperatorSessionCookieWithEntropy(
  options: OperatorSessionCookieOptions,
  entropy: EntropySource
): OperatorSessionCookie {
  const configuration = parseOptions(options)

  return {
    async issue({ principalId }) {
      if (!validPrincipalId(principalId)) throw new OperatorSessionCookieError()
      const issuedAt = nowSeconds(configuration.now)
      const expiresAt = issuedAt + configuration.ttlSeconds
      if (!validUnixSeconds(expiresAt)) throw new OperatorSessionCookieError()
      const key = configuration.keys[0]
      const claims: Claims = {
        v: 1,
        k: key.id,
        d: configuration.deploymentId,
        p: principalId,
        i: issuedAt,
        n: issuedAt,
        e: expiresAt,
        j: base64url(secureRandom(entropy, SESSION_ID_BYTES)),
      }
      const plaintext = JSON.stringify(claims)
      const nonce = secureRandom(entropy, NONCE_BYTES)
      try {
        const cipher = createCipheriv("aes-256-gcm", key.secret, nonce)
        cipher.setAAD(Buffer.from(associatedData(key.id), "utf8"))
        const ciphertext = Buffer.concat([
          cipher.update(plaintext, "utf8"),
          cipher.final(),
        ])
        const token = [
          COOKIE_VERSION,
          key.id,
          base64url(nonce),
          ciphertext.toString("base64url"),
          cipher.getAuthTag().toString("base64url"),
        ].join(".")
        return {
          session: {
            principalId: claims.p,
            sessionId: claims.j,
            issuedAt: claims.i,
            expiresAt: claims.e,
          },
          cookie: cookieAttributes(token, configuration.ttlSeconds),
        }
      } catch {
        throw new OperatorSessionCookieError()
      }
    },
    verify(cookieHeader) {
      const token = cookieValue(cookieHeader)
      if (!token) return undefined
      const decrypted = decrypt(token, configuration.keys)
      if (!decrypted) return undefined
      const { claims } = decrypted
      const now = nowSeconds(configuration.now)
      if (
        claims.k !== token.split(".")[1] ||
        claims.d !== configuration.deploymentId ||
        claims.n !== claims.i ||
        claims.e - claims.i !== configuration.ttlSeconds ||
        claims.i > now + configuration.clockSkewSeconds ||
        now - configuration.clockSkewSeconds >= claims.e
      )
        return undefined
      return {
        principalId: claims.p,
        sessionId: claims.j,
        issuedAt: claims.i,
        expiresAt: claims.e,
      }
    },
    clear() {
      return cookieAttributes("", 0)
    },
  }
}

export function createOperatorSessionCookie(
  options: OperatorSessionCookieOptions
): OperatorSessionCookie {
  return createOperatorSessionCookieWithEntropy(
    options,
    (size) => new Uint8Array(randomBytes(size))
  )
}

/**
 * Test-only deterministic entropy seam. Production construction always uses
 * Node's cryptographically secure random source.
 */
export function createOperatorSessionCookieForTest(
  options: OperatorSessionCookieOptions,
  entropy: EntropySource
): OperatorSessionCookie {
  return createOperatorSessionCookieWithEntropy(options, entropy)
}
