import { GUEST_PRINCIPAL_PREFIX } from "../core/principal"
import type {
  GuestAuthorization,
  GuestInvitationService,
  GuestOperation,
  VerifiedGuestAuthorization,
  VerifiedGuestIdentity,
} from "./guest-invitation"

export function guestBearerToken(request: Request) {
  const value = request.headers.get("authorization")
  const match = value === null ? null : /^Bearer ([^\s]{1,4096})$/u.exec(value)
  return match?.[1]
}

export function guestAuthorizationActive(
  authorization: { authorizationExpiresAt: number },
  now: () => number
) {
  try {
    const current = now()
    return (
      Number.isSafeInteger(current) &&
      authorization.authorizationExpiresAt * 1_000 > current
    )
  } catch {
    return false
  }
}

export function guestPrincipalId(authorization: GuestAuthorization) {
  return `${GUEST_PRINCIPAL_PREFIX}${authorization.tokenId}`
}

export function createGuestRequestAuthorizer(options: {
  runtimeId: string
  invitations: GuestInvitationService
  now: () => number
}) {
  const authorize = (
    identity: VerifiedGuestIdentity,
    target: { agentId: string; sessionId: string; operation: GuestOperation }
  ): VerifiedGuestAuthorization | undefined => {
    return identity.runtimeId === options.runtimeId &&
      identity.agentId === target.agentId &&
      identity.ref === target.sessionId &&
      guestAuthorizationActive(identity, options.now)
      ? { ...identity, operation: target.operation }
      : undefined
  }

  return {
    authorize,
    async authenticate(request: Request) {
      const token = guestBearerToken(request)
      const identity = token
        ? await options.invitations.verify(token)
        : undefined
      return identity && guestAuthorizationActive(identity, options.now)
        ? identity
        : undefined
    },
  }
}
