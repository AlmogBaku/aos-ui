import { createHash } from "node:crypto"

import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose"
import { z } from "zod"

const ALGORITHM = "HS256"
const TOKEN_TYPE = "aos-guest-invitation+jwt"
const TOKEN_ISSUER = "aos-invite"
const TOKEN_AUDIENCE = "aos-guest"
const MAX_TOKEN_BYTES = 3 * 1_024
const MAX_UNIX_SECONDS = 4_102_444_800

export const guestOperations = [
  "audio:speak",
  "audio:transcribe",
  "artifacts:read",
  "attachments:read",
  "errors:read",
  "interactions:respond",
  "messages:create",
  "messages:read",
  "messages:stop",
] as const

export const guestCapabilities = [
  "audio-speech",
  "audio-transcription",
  "artifact-metadata",
  "attachment-metadata",
  "custom-ui",
  "message-text",
  "safe-errors",
] as const

export type GuestOperation = (typeof guestOperations)[number]
export type GuestCapability = (typeof guestCapabilities)[number]

const IdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
const ReferenceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)
const UnixSecondsSchema = z.number().int().min(0).max(MAX_UNIX_SECONDS)
const PlainTextSchema = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code !== 127 && (code >= 32 || [9, 10, 13].includes(code))
      })
    )
const SingleLineSchema = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code >= 32 && code !== 127
      })
    )

const FirstTurnSchema = z
  .strictObject({
    instruction: PlainTextSchema(2_000).min(1).optional(),
    prefill: PlainTextSchema(2_000).min(1).optional(),
  })
  .refine(
    (value) => value.instruction !== undefined || value.prefill !== undefined
  )
const UiSchema = z
  .strictObject({
    lang: z.enum(["en", "he"]).optional(),
    name: SingleLineSchema(128).optional(),
    logoUrl: z
      .string()
      .max(512)
      .url()
      .refine((value) => {
        const url = new URL(value)
        return url.protocol === "https:" && !url.username && !url.password
      })
      .optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/u)
      .optional(),
    title: SingleLineSchema(256).optional(),
    message: PlainTextSchema(1_500).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined))

export type GuestFirstTurn = z.infer<typeof FirstTurnSchema>
export type GuestInvitationUi = z.infer<typeof UiSchema>

export type GuestInvitationKey = { id: string; secret: Uint8Array }
export type GuestInvitationOptions = {
  issuer: "aos-invite"
  audience: "aos-guest"
  deploymentId: string
  runtimeId: string
  keys: readonly GuestInvitationKey[]
  now?: () => number
  ttlSeconds?: number
  clockSkewSeconds?: number
}
export type GuestInvitationRequest = {
  agentId: string
  ref: string
  expiresInSeconds?: number
  firstTurn?: GuestFirstTurn
  ui?: GuestInvitationUi
}

export type GuestIdentity = {
  version: 1
  lane: "guest"
  issuer: "aos-invite"
  audience: "aos-guest"
  deploymentId: string
  principalId: string
  invitationId: string
  runtimeId: string
  agentId: string
  sessionId: string
  ref: string
  firstTurn?: GuestFirstTurn
  ui?: GuestInvitationUi
  capabilities: readonly GuestCapability[]
  tokenId: string
  issuedAt: number
  notBefore: number
  expiresAt: number
}
export type GuestInvitationGrant = GuestIdentity & {
  operations: readonly GuestOperation[]
}
export type GuestAuthorization = GuestIdentity & { operation: GuestOperation }
export type VerifiedGuestAuthorization = GuestAuthorization & {
  authorizationExpiresAt: number
}
export type VerifiedGuestIdentity = GuestIdentity & {
  authorizationExpiresAt: number
}
export type GuestInvitationService = {
  issue(request: GuestInvitationRequest): Promise<{
    token: string
    grant: GuestInvitationGrant
  }>
  verify(token: string): Promise<VerifiedGuestIdentity | undefined>
}

const RequestSchema = z.strictObject({
  agentId: IdentifierSchema,
  ref: ReferenceSchema,
  expiresInSeconds: z.number().int().positive().optional(),
  firstTurn: FirstTurnSchema.optional(),
  ui: UiSchema.optional(),
})
const ClaimsSchema = z.strictObject({
  v: z.literal(1),
  iss: z.literal(TOKEN_ISSUER),
  aud: z.literal(TOKEN_AUDIENCE),
  dep: IdentifierSchema,
  runtime: IdentifierSchema,
  iat: UnixSecondsSchema,
  exp: UnixSecondsSchema,
  agent: IdentifierSchema,
  ref: ReferenceSchema,
  firstTurn: FirstTurnSchema.optional(),
  ui: UiSchema.optional(),
})
type InvitationClaims = z.infer<typeof ClaimsSchema>

/**
 * Field-level reasons for a rejected invitation request, named by the
 * operator-facing input keys so a caller can fix the request it sent.
 */
const requestFieldNames: Record<string, string> = {
  agentId: "agent",
  expiresInSeconds: "expiresIn",
  "firstTurn.instruction": "instruction",
  "firstTurn.prefill": "prefill",
  "ui.logoUrl": "logo",
  firstTurn: "instruction/prefill",
  ui: "lang/name/logo/accent/title/message",
}

export function describeIssues(issues: readonly z.core.$ZodIssue[]) {
  return issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.join(".")
      const field =
        requestFieldNames[path] ?? path.replace(/^(ui|firstTurn)\./u, "")
      if (issue.code === "unrecognized_keys")
        return `unknown field(s): ${issue.keys.join(", ")}`
      if (issue.code === "too_big")
        return `${field}: too long (max ${String(issue.maximum)})`
      if (issue.code === "too_small") return `${field}: must not be empty`
      if (issue.code === "custom" && path)
        return `${field}: contains control characters or is invalid`
      return `${field || "request"}: ${issue.message}`
    })
    .join("; ")
}

export class GuestInvitationError extends Error {
  constructor(message = "Invalid guest invitation") {
    super(message)
    this.name = "GuestInvitationError"
  }
}

function nowSeconds(clock: () => number) {
  const milliseconds = clock()
  const seconds = Math.floor(milliseconds / 1_000)
  if (
    !Number.isSafeInteger(milliseconds) ||
    !UnixSecondsSchema.safeParse(seconds).success
  )
    throw new GuestInvitationError()
  return seconds
}

function identity(
  claims: InvitationClaims,
  deploymentId: string,
  runtimeId: string,
  token: string
): GuestIdentity {
  return {
    version: 1,
    lane: "guest",
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    deploymentId,
    principalId: `guest_${claims.ref}`,
    invitationId: `invite_${claims.ref}`,
    runtimeId,
    agentId: claims.agent,
    sessionId: claims.ref,
    ref: claims.ref,
    ...(claims.firstTurn ? { firstTurn: claims.firstTurn } : {}),
    ...(claims.ui ? { ui: claims.ui } : {}),
    capabilities: guestCapabilities,
    tokenId: createHash("sha256").update(token).digest("base64url"),
    issuedAt: claims.iat,
    notBefore: claims.iat,
    expiresAt: claims.exp,
  }
}

export function createGuestInvitationService(
  raw: GuestInvitationOptions
): GuestInvitationService {
  const ttlSeconds = raw.ttlSeconds ?? 259_200
  const clockSkewSeconds = raw.clockSkewSeconds ?? 0
  const validOptions =
    raw.issuer === TOKEN_ISSUER &&
    raw.audience === TOKEN_AUDIENCE &&
    IdentifierSchema.safeParse(raw.deploymentId).success &&
    IdentifierSchema.safeParse(raw.runtimeId).success &&
    raw.keys.length >= 1 &&
    raw.keys.length <= 3 &&
    raw.keys.every(
      ({ id, secret }) =>
        /^[A-Za-z0-9_-]{1,32}$/u.test(id) &&
        secret instanceof Uint8Array &&
        secret.byteLength === 32
    ) &&
    new Set(raw.keys.map(({ id }) => id)).size === raw.keys.length &&
    Number.isInteger(ttlSeconds) &&
    ttlSeconds >= 60 &&
    ttlSeconds <= 2_592_000 &&
    Number.isInteger(clockSkewSeconds) &&
    clockSkewSeconds >= 0 &&
    clockSkewSeconds <= 60
  if (!validOptions) throw new GuestInvitationError()

  const keys = raw.keys.map(({ id, secret }) => ({
    id,
    secret: secret.slice(),
  }))
  const clock = raw.now ?? Date.now
  return {
    async issue(candidate) {
      const parsed = RequestSchema.safeParse(candidate)
      if (!parsed.success)
        throw new GuestInvitationError(describeIssues(parsed.error.issues))
      const issuedAt = nowSeconds(clock)
      const expiresInSeconds = parsed.data.expiresInSeconds ?? ttlSeconds
      if (expiresInSeconds > ttlSeconds)
        throw new GuestInvitationError(
          `expiresIn: exceeds the ${ttlSeconds}s maximum`
        )
      const claims = ClaimsSchema.parse({
        v: 1,
        iss: TOKEN_ISSUER,
        aud: TOKEN_AUDIENCE,
        dep: raw.deploymentId,
        runtime: raw.runtimeId,
        iat: issuedAt,
        exp: issuedAt + expiresInSeconds,
        agent: parsed.data.agentId,
        ref: parsed.data.ref,
        ...(parsed.data.firstTurn ? { firstTurn: parsed.data.firstTurn } : {}),
        ...(parsed.data.ui ? { ui: parsed.data.ui } : {}),
      })
      const token = await new SignJWT(claims)
        .setProtectedHeader({
          alg: ALGORITHM,
          kid: keys[0].id,
          typ: TOKEN_TYPE,
        })
        .sign(keys[0].secret)
      if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES)
        throw new GuestInvitationError(
          `invitation: signed token exceeds ${MAX_TOKEN_BYTES} bytes; shorten instruction, prefill or message`
        )
      return {
        token,
        grant: {
          ...identity(claims, raw.deploymentId, raw.runtimeId, token),
          operations: guestOperations,
        },
      }
    },

    async verify(token) {
      if (
        typeof token !== "string" ||
        Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES
      )
        return undefined
      try {
        const header = decodeProtectedHeader(token)
        if (
          Object.keys(header).length !== 3 ||
          header.alg !== ALGORITHM ||
          header.typ !== TOKEN_TYPE ||
          typeof header.kid !== "string"
        )
          return undefined
        const key = keys.find(({ id }) => id === header.kid)
        if (!key) return undefined
        const current = nowSeconds(clock)
        const verified = await jwtVerify(token, key.secret, {
          algorithms: [ALGORITHM],
          audience: TOKEN_AUDIENCE,
          issuer: TOKEN_ISSUER,
          typ: TOKEN_TYPE,
          clockTolerance: clockSkewSeconds,
          currentDate: new Date(current * 1_000),
          requiredClaims: ["iat", "exp"],
        })
        const parsed = ClaimsSchema.safeParse(verified.payload)
        if (
          !parsed.success ||
          parsed.data.dep !== raw.deploymentId ||
          parsed.data.runtime !== raw.runtimeId ||
          parsed.data.exp <= parsed.data.iat ||
          parsed.data.exp - parsed.data.iat > ttlSeconds ||
          current < parsed.data.iat - clockSkewSeconds ||
          current > parsed.data.exp + clockSkewSeconds
        )
          return undefined
        return {
          ...identity(parsed.data, raw.deploymentId, raw.runtimeId, token),
          authorizationExpiresAt: parsed.data.exp + clockSkewSeconds,
        }
      } catch {
        return undefined
      }
    },
  }
}
