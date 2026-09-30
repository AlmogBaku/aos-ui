import { randomBytes } from "node:crypto"

import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose"
import { z } from "zod"

/**
 * Passes that open one tool call's files, or one published Artifact's bytes,
 * to an MCP App. A view reads from an
 * opaque origin that no login reaches, so each file address carries a pass.
 * The key never leaves this process, so a restart ends every pass.
 */

const ALGORITHM = "HS256"
const TOKEN_TYPE = "aos-file-pass+jwt"
const TOKEN_ISSUER = "aos-proxy"
const TOKEN_AUDIENCE = "aos-app-files"
const MAX_TOKEN_BYTES = 4 * 1_024
const MAX_UNIX_SECONDS = 4_102_444_800
/** A pass's longest life: 10 minutes. */
const LIFETIME_SECONDS = 600

/**
 * What a pass opens, for one role: one tool call's files, or one published
 * Artifact's bytes. A pass for one kind never opens the other.
 */
export type FilePassScope = {
  role: "operator" | "guest"
  agentId: string
  /** The Session as its listener names it: a public id, or a guest's ref. */
  sessionId: string
} & ({ toolCallId: string } | { artifactId: string })

export type FilePassService = {
  /**
   * A pass for one subject that ends after 10 minutes, or at `notAfter` (Unix
   * seconds) when that comes first; `expiresAt` is in Unix seconds too.
   */
  issue(
    scope: FilePassScope,
    notAfter?: number
  ): Promise<{ pass: string; expiresAt: number }>
  /** Whether `pass` opens exactly this subject now. */
  opens(pass: string, scope: FilePassScope): Promise<boolean>
}

const UnixSecondsSchema = z.number().int().min(0).max(MAX_UNIX_SECONDS)
const ClaimsSchema = z.strictObject({
  iss: z.literal(TOKEN_ISSUER),
  aud: z.literal(TOKEN_AUDIENCE),
  iat: UnixSecondsSchema,
  exp: UnixSecondsSchema,
  role: z.enum(["operator", "guest"]),
  agent: z.string(),
  session: z.string(),
  /** The subject's kind and id: a tool call's id, or an Artifact's. */
  kind: z.enum(["call", "artifact"]),
  subject: z.string(),
})

function subjectClaims(scope: FilePassScope) {
  return "toolCallId" in scope
    ? { kind: "call" as const, subject: scope.toolCallId }
    : { kind: "artifact" as const, subject: scope.artifactId }
}

function nowSeconds(clock: () => number) {
  const milliseconds = clock()
  const seconds = Math.floor(milliseconds / 1_000)
  if (
    !Number.isSafeInteger(milliseconds) ||
    !UnixSecondsSchema.safeParse(seconds).success
  )
    throw new Error("Invalid clock")
  return seconds
}

export function createFilePassService(
  options: { now?: () => number } = {}
): FilePassService {
  const secret = randomBytes(32)
  const clock = options.now ?? Date.now
  return {
    async issue(scope, notAfter = Infinity) {
      const issuedAt = nowSeconds(clock)
      const claims = ClaimsSchema.parse({
        iss: TOKEN_ISSUER,
        aud: TOKEN_AUDIENCE,
        iat: issuedAt,
        exp: Math.min(issuedAt + LIFETIME_SECONDS, notAfter),
        role: scope.role,
        agent: scope.agentId,
        session: scope.sessionId,
        ...subjectClaims(scope),
      })
      const pass = await new SignJWT(claims)
        .setProtectedHeader({ alg: ALGORITHM, typ: TOKEN_TYPE })
        .sign(secret)
      return { pass, expiresAt: claims.exp }
    },

    async opens(pass, scope) {
      if (
        typeof pass !== "string" ||
        Buffer.byteLength(pass, "utf8") > MAX_TOKEN_BYTES
      )
        return false
      try {
        const header = decodeProtectedHeader(pass)
        if (
          Object.keys(header).length !== 2 ||
          header.alg !== ALGORITHM ||
          header.typ !== TOKEN_TYPE
        )
          return false
        const current = nowSeconds(clock)
        const verified = await jwtVerify(pass, secret, {
          algorithms: [ALGORITHM],
          audience: TOKEN_AUDIENCE,
          issuer: TOKEN_ISSUER,
          typ: TOKEN_TYPE,
          currentDate: new Date(current * 1_000),
          requiredClaims: ["iat", "exp"],
        })
        const claims = ClaimsSchema.safeParse(verified.payload)
        const subject = subjectClaims(scope)
        return (
          claims.success &&
          claims.data.role === scope.role &&
          claims.data.agent === scope.agentId &&
          claims.data.session === scope.sessionId &&
          claims.data.kind === subject.kind &&
          claims.data.subject === subject.subject
        )
      } catch {
        return false
      }
    },
  }
}
