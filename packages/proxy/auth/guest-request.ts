import type {
  GuestAuthorization,
  GuestInvitationService,
  GuestOperation,
  VerifiedGuestAuthorization,
} from "./guest-invitation"

export function guestBearerToken(request: Request) {
  const value = request.headers.get("authorization")
  const match = value === null ? null : /^Bearer ([^\s]{1,4096})$/u.exec(value)
  return match?.[1]
}

export function guestCookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie")
  if (header === null || header.length > 8_192) return undefined
  const values = header
    .split(";")
    .map((item) => item.trim())
    .flatMap((item) => {
      const separator = item.indexOf("=")
      return separator > 0 && item.slice(0, separator) === name
        ? [item.slice(separator + 1)]
        : []
    })
  return values.length === 1 ? values[0] : undefined
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

export function sameGuestBinding(
  first: GuestAuthorization,
  second: GuestAuthorization
) {
  return (
    first.runtimeId === second.runtimeId &&
    first.principalId === second.principalId &&
    first.invitationId === second.invitationId &&
    first.tokenId === second.tokenId &&
    first.agentId === second.agentId &&
    first.sessionId === second.sessionId
  )
}

export function guestControllerId(authorization: GuestAuthorization) {
  return `guest:${authorization.tokenId}`
}

export function createGuestRequestAuthorizer(options: {
  runtimeId: string
  invitations: GuestInvitationService
  now: () => number
}) {
  const verify = async (
    token: string,
    target: { agentId: string; sessionId: string; operation: GuestOperation }
  ): Promise<VerifiedGuestAuthorization | undefined> => {
    const authorization = await options.invitations.verify(token, {
      runtimeId: options.runtimeId,
      ...target,
    })
    return authorization?.sessionId === target.sessionId &&
      guestAuthorizationActive(authorization, options.now)
      ? authorization
      : undefined
  }

  return {
    verify,
    async authorize(
      request: Request,
      target: { agentId: string; sessionId: string; operation: GuestOperation }
    ) {
      const token = guestBearerToken(request)
      return token ? verify(token, target) : undefined
    },
  }
}
