import type {
  GuestOperation,
  VerifiedGuestIdentity,
} from "../auth/guest-invitation"
import type { GuestInvitationService } from "../auth/guest-invitation"
import { projectGuestError } from "../auth/guest-runtime-projection"
import { createGuestRequestAuthorizer } from "../auth/guest-request"
import type { GuestPublicErrorCode } from "../auth/guest-projection"
import { AttachmentStageRegistry } from "../core/attachment-stages"
import type { RuntimeInstance } from "../core/runtime"

export const guestSecurityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const

const inactiveInvitation = {
  error: {
    code: "invitation_inactive",
    description:
      "This invitation link is no longer active. Please ask the person who invited you to send a new one.",
  },
} as const

export type GuestAppOptions = {
  publicOrigin: string
  runtime: RuntimeInstance
  invitations: GuestInvitationService
  now?: () => number
  schedule?: (delayMs: number, task: () => void) => unknown
  cancel?: (timer: unknown) => void
}

export type GuestRoutes = ReturnType<typeof createGuestRoutes>

export function emptyError(status: number) {
  return new Response(null, { status })
}

export function invitationError() {
  return Response.json(inactiveInvitation, { status: 401 })
}

export function createGuestRoutes(options: GuestAppOptions) {
  const now = options.now ?? Date.now
  const authorizer = createGuestRequestAuthorizer({
    runtimeId: options.runtime.id,
    invitations: options.invitations,
    now,
  })
  let subscriberSequence = 0
  const activeStreams = new Map<string, number>()
  let activeStreamTotal = 0
  return {
    options,
    now,
    schedule:
      options.schedule ??
      ((delayMs: number, task: () => void) => setTimeout(task, delayMs)),
    cancel:
      options.cancel ?? ((timer: unknown) => clearTimeout(timer as number)),
    attachmentStages: new AttachmentStageRegistry(
      256,
      300_000,
      67_108_864,
      4
    ),
    authenticate: (request: Request) => authorizer.authenticate(request),
    authorize: (
      identity: VerifiedGuestIdentity,
      agentId: string,
      ref: string,
      operation: GuestOperation
    ) => authorizer.authorize(identity, { agentId, sessionId: ref, operation }),
    nextSubscriberId(tokenId: string) {
      return `${tokenId}:${++subscriberSequence}`
    },
    acquireStream(tokenId: string) {
      const count = activeStreams.get(tokenId) ?? 0
      if (count >= 4 || activeStreamTotal >= 64) return undefined
      activeStreams.set(tokenId, count + 1)
      activeStreamTotal += 1
      let released = false
      return () => {
        if (released) return
        released = true
        const next = (activeStreams.get(tokenId) ?? 1) - 1
        activeStreamTotal -= 1
        if (next > 0) activeStreams.set(tokenId, next)
        else activeStreams.delete(tokenId)
      }
    },
    projectedError(
      identity: VerifiedGuestIdentity,
      agentId: string,
      ref: string,
      code: GuestPublicErrorCode,
      retryable: boolean,
      status: number
    ) {
      const authorization = authorizer.authorize(identity, {
        agentId,
        sessionId: ref,
        operation: "errors:read",
      })
      return authorization
        ? projectGuestError(authorization, code, retryable, status)
        : emptyError(status)
    },
  }
}

export function guestPageQuery(requestUrl: string) {
  const url = new URL(requestUrl)
  if (
    url.search.length > 2_048 ||
    [...url.searchParams.keys()].some(
      (key) => key !== "limit" && key !== "offset"
    ) ||
    url.searchParams.getAll("limit").length > 1 ||
    url.searchParams.getAll("offset").length > 1
  )
    return undefined
  const integer = (name: "limit" | "offset", fallback: number) => {
    const value = url.searchParams.get(name)
    if (value === null) return fallback
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  const limit = integer("limit", 200)
  const offset = integer("offset", 0)
  return limit !== undefined &&
    offset !== undefined &&
    limit >= 1 &&
    limit <= 500
    ? { limit, offset }
    : undefined
}

export function encodedFilename(filename: string) {
  return encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}
