import { OperatorAuthStateSchema, type OperatorAuthState } from "../protocol"

export type VerifiedOidcSession = {
  subject: string
  displayName?: string
}

export type OperatorAuthenticator = {
  state(request: Request): Promise<OperatorAuthState>
  require(
    request: Request
  ): Promise<Extract<OperatorAuthState, { status: "authenticated" }>>
}

export function createOperatorAuthenticator(options: {
  allowedSubjects: readonly string[]
  verifySession(request: Request): Promise<VerifiedOidcSession | undefined>
}): OperatorAuthenticator {
  const allowlist = new Set(options.allowedSubjects)
  async function state(request: Request): Promise<OperatorAuthState> {
    try {
      const session = await options.verifySession(request)
      if (!session || !allowlist.has(session.subject))
        return { status: "unauthenticated" }
      return OperatorAuthStateSchema.parse({
        status: "authenticated",
        operator: {
          id: session.subject,
          ...(session.displayName ? { displayName: session.displayName } : {}),
        },
      })
    } catch {
      return { status: "unauthenticated" }
    }
  }
  return {
    state,
    async require(request) {
      const result = await state(request)
      if (result.status !== "authenticated") throw new OperatorAuthError()
      return result
    },
  }
}

export class OperatorAuthError extends Error {
  constructor() {
    super("Operator authentication required")
    this.name = "OperatorAuthError"
  }
}
