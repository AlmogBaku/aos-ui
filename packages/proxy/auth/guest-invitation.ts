import { randomBytes } from "node:crypto"

import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose"

const ALGORITHM = "HS256"
const TOKEN_TYPE = "aos-guest-invitation+jwt"
const MAX_TOKEN_BYTES = 4_096
const MAX_HEADER_BYTES = 256
const MAX_CLAIMS_BYTES = 2_048
const TOKEN_ID_BYTES = 32

export const guestOperations = [
  "artifacts:read",
  "attachments:read",
  "errors:read",
  "messages:create",
  "messages:read",
] as const

export const guestCapabilities = [
  "artifact-metadata",
  "attachment-metadata",
  "custom-ui",
  "message-text",
  "safe-errors",
] as const

export type GuestOperation = (typeof guestOperations)[number]
export type GuestCapability = (typeof guestCapabilities)[number]

export type GuestInvitationKey = {
  id: string
  secret: Uint8Array
}

export type GuestInvitationOptions = {
  issuer: string
  audience: string
  deploymentId: string
  keys: readonly GuestInvitationKey[]
  now?: () => number
  ttlSeconds?: number
  clockSkewSeconds?: number
}

export type GuestInvitationRequest = {
  principalId: string
  invitationId: string
  agentId: string
  sessionId?: string
  operations: readonly GuestOperation[]
  capabilities: readonly GuestCapability[]
}

export type GuestInvitationTarget = {
  agentId: string
  sessionId?: string
  operation: GuestOperation
}

type GuestIdentity = {
  version: 1
  lane: "guest"
  issuer: string
  audience: string
  deploymentId: string
  principalId: string
  invitationId: string
  agentId: string
  sessionId?: string
  capabilities: readonly GuestCapability[]
  tokenId: string
  issuedAt: number
  notBefore: number
  expiresAt: number
}

export type GuestInvitationGrant = GuestIdentity & {
  operations: readonly GuestOperation[]
}

export type GuestAuthorization = GuestIdentity & {
  operation: GuestOperation
}

export type VerifiedGuestAuthorization = GuestAuthorization & {
  /** Effective authorization boundary after applying the configured tolerance. */
  authorizationExpiresAt: number
}

export type GuestInvitationService = {
  issue(request: GuestInvitationRequest): Promise<{
    token: string
    grant: GuestInvitationGrant
  }>
  verify(
    token: string,
    target: GuestInvitationTarget
  ): Promise<VerifiedGuestAuthorization | undefined>
}

type EntropySource = (size: number) => Uint8Array

type ParsedOptions = {
  issuer: string
  audience: string
  deploymentId: string
  keys: readonly GuestInvitationKey[]
  now: () => number
  ttlSeconds: number
  clockSkewSeconds: number
}

type InvitationClaims = {
  aud: string
  agent: string
  caps: GuestCapability[]
  dep: string
  exp: number
  iat: number
  inv: string
  iss: string
  jti: string
  lane: "guest"
  nbf: number
  ops: GuestOperation[]
  session?: string
  sub: string
  v: 1
}

export class GuestInvitationError extends Error {
  constructor() {
    super("Invalid guest invitation")
    this.name = "GuestInvitationError"
  }
}

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8")
}

function validIdentifier(value: unknown, maximumBytes = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= maximumBytes &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
}

function validGuestPrincipal(value: unknown): value is string {
  return validIdentifier(value) && /^guest_[A-Za-z0-9._:-]+$/u.test(value)
}

function validInvitationId(value: unknown): value is string {
  return validIdentifier(value) && /^invite_[A-Za-z0-9._:-]+$/u.test(value)
}

function validIssuer(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > 512)
    return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    )
  } catch {
    return false
  }
}

function validUnixSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 4_102_444_800
  )
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
) {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key)) &&
    keys.length ===
      required.length + optional.filter((key) => key in value).length
  )
}

function canonicalScope<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > allowed.length ||
    value.some(
      (item) => typeof item !== "string" || !allowed.includes(item as T)
    ) ||
    new Set(value).size !== value.length
  )
    return undefined
  const sorted = [...value].sort() as T[]
  return sorted.every((item, index) => item === value[index])
    ? sorted
    : undefined
}

function requestedScope<T extends string>(
  value: readonly T[],
  allowed: readonly T[]
) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > allowed.length ||
    value.some((item) => !allowed.includes(item)) ||
    new Set(value).size !== value.length
  )
    throw new GuestInvitationError()
  return [...value].sort() as T[]
}

function parseOptions(options: GuestInvitationOptions): ParsedOptions {
  const ttlSeconds = options.ttlSeconds ?? 300
  const clockSkewSeconds = options.clockSkewSeconds ?? 10
  if (
    !validIssuer(options.issuer) ||
    !validIdentifier(options.audience, 128) ||
    !validIdentifier(options.deploymentId, 128) ||
    !Array.isArray(options.keys) ||
    options.keys.length < 1 ||
    options.keys.length > 3 ||
    options.keys.some(
      (key) =>
        !validIdentifier(key.id, 32) ||
        !(key.secret instanceof Uint8Array) ||
        key.secret.byteLength !== 32
    ) ||
    new Set(options.keys.map((key) => key.id)).size !== options.keys.length ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 30 ||
    ttlSeconds > 3_600 ||
    !Number.isInteger(clockSkewSeconds) ||
    clockSkewSeconds < 0 ||
    clockSkewSeconds > 60 ||
    (options.now !== undefined && typeof options.now !== "function")
  )
    throw new GuestInvitationError()
  return {
    issuer: options.issuer,
    audience: options.audience,
    deploymentId: options.deploymentId,
    keys: options.keys.map((key) => ({
      id: key.id,
      secret: key.secret.slice(),
    })),
    now: options.now ?? Date.now,
    ttlSeconds,
    clockSkewSeconds,
  }
}

function nowSeconds(clock: () => number) {
  let milliseconds: number
  try {
    milliseconds = clock()
  } catch {
    throw new GuestInvitationError()
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new GuestInvitationError()
  const seconds = Math.floor(milliseconds / 1_000)
  if (!validUnixSeconds(seconds)) throw new GuestInvitationError()
  return seconds
}

function tokenId(source: EntropySource) {
  let entropy: Uint8Array
  try {
    entropy = source(TOKEN_ID_BYTES)
  } catch {
    throw new GuestInvitationError()
  }
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== TOKEN_ID_BYTES)
    throw new GuestInvitationError()
  return Buffer.from(entropy).toString("base64url")
}

function parseRequest(request: GuestInvitationRequest) {
  if (
    typeof request !== "object" ||
    request === null ||
    !exactKeys(
      request as unknown as Record<string, unknown>,
      ["principalId", "invitationId", "agentId", "operations", "capabilities"],
      ["sessionId"]
    ) ||
    !validGuestPrincipal(request.principalId) ||
    !validInvitationId(request.invitationId) ||
    !validIdentifier(request.agentId) ||
    (request.sessionId !== undefined && !validIdentifier(request.sessionId))
  )
    throw new GuestInvitationError()
  return {
    principalId: request.principalId,
    invitationId: request.invitationId,
    agentId: request.agentId,
    ...(request.sessionId === undefined
      ? {}
      : { sessionId: request.sessionId }),
    operations: requestedScope(request.operations, guestOperations),
    capabilities: requestedScope(request.capabilities, guestCapabilities),
  }
}

function parseClaims(
  value: unknown,
  options: ParsedOptions
): InvitationClaims | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  const claims = value as Record<string, unknown>
  if (
    !exactKeys(
      claims,
      [
        "aud",
        "agent",
        "caps",
        "dep",
        "exp",
        "iat",
        "inv",
        "iss",
        "jti",
        "lane",
        "nbf",
        "ops",
        "sub",
        "v",
      ],
      ["session"]
    ) ||
    claims.v !== 1 ||
    claims.lane !== "guest" ||
    claims.iss !== options.issuer ||
    claims.aud !== options.audience ||
    claims.dep !== options.deploymentId ||
    !validGuestPrincipal(claims.sub) ||
    !validInvitationId(claims.inv) ||
    !validIdentifier(claims.agent) ||
    (claims.session !== undefined && !validIdentifier(claims.session)) ||
    !validIdentifier(claims.jti, 64) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(claims.jti) ||
    !validUnixSeconds(claims.iat) ||
    !validUnixSeconds(claims.nbf) ||
    !validUnixSeconds(claims.exp) ||
    claims.nbf !== claims.iat ||
    claims.exp - claims.iat !== options.ttlSeconds
  )
    return undefined
  const operations = canonicalScope(claims.ops, guestOperations)
  const capabilities = canonicalScope(claims.caps, guestCapabilities)
  if (!operations || !capabilities) return undefined
  return {
    aud: claims.aud,
    agent: claims.agent,
    caps: capabilities,
    dep: claims.dep,
    exp: claims.exp,
    iat: claims.iat,
    inv: claims.inv,
    iss: claims.iss,
    jti: claims.jti,
    lane: "guest",
    nbf: claims.nbf,
    ops: operations,
    ...(claims.session === undefined ? {} : { session: claims.session }),
    sub: claims.sub,
    v: 1,
  }
}

function identity(claims: InvitationClaims): GuestIdentity {
  return {
    version: 1,
    lane: "guest",
    issuer: claims.iss,
    audience: claims.aud,
    deploymentId: claims.dep,
    principalId: claims.sub,
    invitationId: claims.inv,
    agentId: claims.agent,
    ...(claims.session === undefined ? {} : { sessionId: claims.session }),
    capabilities: claims.caps,
    tokenId: claims.jti,
    issuedAt: claims.iat,
    notBefore: claims.nbf,
    expiresAt: claims.exp,
  }
}

function grant(claims: InvitationClaims): GuestInvitationGrant {
  return { ...identity(claims), operations: claims.ops }
}

function authorization(
  claims: InvitationClaims,
  operation: GuestOperation,
  clockSkewSeconds: number
): VerifiedGuestAuthorization {
  return {
    ...identity(claims),
    operation,
    authorizationExpiresAt: claims.exp + clockSkewSeconds,
  }
}

function makeService(
  rawOptions: GuestInvitationOptions,
  entropy: EntropySource
): GuestInvitationService {
  const options = parseOptions(rawOptions)
  return {
    async issue(rawRequest) {
      const request = parseRequest(rawRequest)
      const issuedAt = nowSeconds(options.now)
      const claims: InvitationClaims = {
        aud: options.audience,
        agent: request.agentId,
        caps: request.capabilities,
        dep: options.deploymentId,
        exp: issuedAt + options.ttlSeconds,
        iat: issuedAt,
        inv: request.invitationId,
        iss: options.issuer,
        jti: tokenId(entropy),
        lane: "guest",
        nbf: issuedAt,
        ops: request.operations,
        ...(request.sessionId === undefined
          ? {}
          : { session: request.sessionId }),
        sub: request.principalId,
        v: 1,
      }
      if (!validUnixSeconds(claims.exp)) throw new GuestInvitationError()
      const token = await new SignJWT(claims)
        .setProtectedHeader({
          alg: ALGORITHM,
          kid: options.keys[0].id,
          typ: TOKEN_TYPE,
        })
        .sign(options.keys[0].secret)
      if (utf8Bytes(token) > MAX_TOKEN_BYTES) throw new GuestInvitationError()
      return { token, grant: grant(claims) }
    },

    async verify(token, target) {
      if (
        typeof token !== "string" ||
        utf8Bytes(token) > MAX_TOKEN_BYTES ||
        typeof target !== "object" ||
        target === null ||
        !exactKeys(
          target as unknown as Record<string, unknown>,
          ["agentId", "operation"],
          ["sessionId"]
        ) ||
        !validIdentifier(target.agentId) ||
        !guestOperations.includes(target.operation) ||
        (target.sessionId !== undefined && !validIdentifier(target.sessionId))
      )
        return undefined
      try {
        const segments = token.split(".")
        if (
          segments.length !== 3 ||
          Buffer.from(segments[0], "base64url").byteLength > MAX_HEADER_BYTES ||
          Buffer.from(segments[1], "base64url").byteLength > MAX_CLAIMS_BYTES
        )
          return undefined
        const header = decodeProtectedHeader(token)
        if (
          !exactKeys(header as Record<string, unknown>, [
            "alg",
            "kid",
            "typ",
          ]) ||
          header.alg !== ALGORITHM ||
          header.typ !== TOKEN_TYPE ||
          !validIdentifier(header.kid, 32)
        )
          return undefined
        const key = options.keys.find(
          (candidate) => candidate.id === header.kid
        )
        if (!key) return undefined
        const current = nowSeconds(options.now)
        const result = await jwtVerify(token, key.secret, {
          algorithms: [ALGORITHM],
          audience: options.audience,
          issuer: options.issuer,
          typ: TOKEN_TYPE,
          clockTolerance: options.clockSkewSeconds,
          currentDate: new Date(current * 1_000),
          requiredClaims: ["iat", "nbf", "exp", "jti", "sub"],
        })
        const claims = parseClaims(result.payload, options)
        if (
          !claims ||
          Buffer.from(JSON.stringify(claims), "utf8").toString("base64url") !==
            segments[1] ||
          claims.agent !== target.agentId ||
          !claims.ops.includes(target.operation) ||
          (claims.session !== undefined &&
            claims.session !== target.sessionId) ||
          current < claims.nbf - options.clockSkewSeconds ||
          current > claims.exp + options.clockSkewSeconds
        )
          return undefined
        return authorization(claims, target.operation, options.clockSkewSeconds)
      } catch {
        return undefined
      }
    },
  }
}

export function createGuestInvitationService(
  options: GuestInvitationOptions
): GuestInvitationService {
  return makeService(options, randomBytes)
}

export function createGuestInvitationServiceForTest(
  options: GuestInvitationOptions,
  entropy: EntropySource
): GuestInvitationService {
  return makeService(options, entropy)
}
