import type {
  GuestOperation,
  VerifiedGuestIdentity,
} from "../auth/guest-invitation"
import type { GuestInvitationService } from "../auth/guest-invitation"
import { projectGuestError } from "../auth/guest-runtime-projection"
import { createGuestRequestAuthorizer } from "../auth/guest-request"
import type { GuestPublicErrorCode } from "../auth/guest-projection"
import { AttachmentStageRegistry } from "../core/attachment-stages"
import type { RuntimeInstance, ServerAttachmentStages } from "../core/runtime"

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
  /** Shared with the guest ACP service so one upload serves either transport. */
  attachmentStages?: ServerAttachmentStages
  now?: () => number
}

/** The guest lane's staging limits: smaller and shorter-lived than operators'. */
export function createGuestAttachmentStages() {
  return new AttachmentStageRegistry(256, 300_000, 67_108_864, 4)
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
  return {
    options,
    attachmentStages: options.attachmentStages ?? createGuestAttachmentStages(),
    authenticate: (request: Request) => authorizer.authenticate(request),
    authorize: (
      identity: VerifiedGuestIdentity,
      agentId: string,
      ref: string,
      operation: GuestOperation
    ) => authorizer.authorize(identity, { agentId, sessionId: ref, operation }),
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

export function encodedFilename(filename: string) {
  return encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}
