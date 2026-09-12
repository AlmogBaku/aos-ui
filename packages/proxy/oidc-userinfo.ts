import type { VerifiedOidcSession } from "./operator-auth"

type OperatorVerifierFactoryOptions = {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

type UserInfo = { sub?: unknown; name?: unknown }

/**
 * Task 1 accepts an already-issued OIDC access bearer at the authentication
 * boundary. Authorization Code + PKCE cookie issuance is added by the later
 * authentication task; this verifier does not invent a local credential.
 */
export function createOidcUserInfoVerifier(
  options: OperatorVerifierFactoryOptions,
  fetcher: typeof fetch = fetch
) {
  return async (request: Request): Promise<VerifiedOidcSession | undefined> => {
    const authorization = request.headers.get("authorization")
    if (!authorization?.startsWith("Bearer ")) return undefined
    const token = authorization.slice("Bearer ".length)
    if (!token || token.length > 16_384) return undefined
    try {
      const response = await fetcher(`${options.issuer}/userinfo`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as UserInfo
      if (typeof body.sub !== "string" || !body.sub) return undefined
      return {
        subject: body.sub,
        ...(typeof body.name === "string" && body.name
          ? { displayName: body.name }
          : {}),
      }
    } catch {
      return undefined
    }
  }
}
