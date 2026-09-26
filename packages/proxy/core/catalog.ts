import type { ProviderSessionId } from "./ids"
import type { ServerRuntime } from "./runtime"

/**
 * The Sessions a runtime holds, as members reach them. It owns the Session
 * list, so a middleware resolving which Session a command addresses asks it.
 */
export type Catalog = {
  /**
   * The Session an invitation addresses by its conversation reference,
   * created on request; `undefined` if there is none yet.
   */
  invited(
    agentId: string,
    ref: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<{ providerSessionId: ProviderSessionId } | undefined>
}

export function createCatalog(
  runtime: Pick<ServerRuntime, "resolveInvitedSession">
): Catalog {
  return {
    invited: (agentId, ref, create) =>
      runtime.resolveInvitedSession(agentId, ref, create),
  }
}
