import { OperatorAuthStateSchema, type OperatorAuthState } from "../../protocol"
import { OperatorAuthError, type OperatorAuthenticator } from "../operator-auth"
import type { OperatorSession, OperatorSessionCookie } from "./session-cookie"

/**
 * Post-OIDC authentication boundary. OIDC has already applied its subject
 * allowlist before issuing this sealed, opaque principal session.
 */
export type OperatorSessionAuthenticator = OperatorAuthenticator & {
  session(request: Request): Promise<OperatorSession | undefined>
}

export function createOperatorSessionAuthenticator(
  cookies: OperatorSessionCookie
): OperatorSessionAuthenticator {
  async function session(
    request: Request
  ): Promise<OperatorSession | undefined> {
    try {
      return cookies.verify(request.headers.get("cookie"))
    } catch {
      return undefined
    }
  }

  async function state(request: Request): Promise<OperatorAuthState> {
    const verified = await session(request)
    if (!verified) return { status: "unauthenticated" }
    return OperatorAuthStateSchema.parse({
      status: "authenticated",
      operator: { id: verified.principalId },
    })
  }

  return {
    session,
    state,
    async require(request) {
      const result = await state(request)
      if (result.status !== "authenticated") throw new OperatorAuthError()
      return result
    },
  }
}
