import {
  CommandRefusedError,
  type Middleware,
  type WorkspaceCapabilities,
} from "../../core/member"
import type { SessionScope } from "../../core/runtime"
import type { GuestGrant } from "./index"

/**
 * The one conversation a guest reaches. A guest addresses it by reference
 * alone, so no other Session is reachable, and the invitation's setup text
 * reaches the runtime only when a Send creates it.
 */

export type GuestScopeOptions = {
  grant: GuestGrant
  /** The invited Session, created on request; `undefined` if there is none. */
  invited(
    agentId: string,
    ref: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<{ sessionId: string } | undefined>
  capabilities(
    scope: Pick<SessionScope, "agentId" | "threadId">
  ): Promise<WorkspaceCapabilities>
}

export function createScopeMiddleware({
  grant,
  invited,
  capabilities,
}: GuestScopeOptions): Middleware {
  const refused = () => new CommandRefusedError("not-found")

  /** The invited Session as a scope; `undefined` means it does not exist yet. */
  async function invitedScope(
    sessionId: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<SessionScope | undefined> {
    if (sessionId !== grant.ref) throw refused()
    const resolved = await invited(grant.agentId, grant.ref, create)
    return resolved
      ? {
          agentId: grant.agentId,
          sessionId: resolved.sessionId,
          threadId: grant.ref,
        }
      : undefined
  }

  return {
    commands: {
      // A fresh invitation has no Session yet: resuming it creates nothing and
      // replays nothing, the way the guest history route serves an empty page,
      // and the first Send resolves it.
      resume: async (command, next) => {
        const scope = await invitedScope(command.sessionId)
        if (scope) return next({ ...command, scope })
        return {
          agentId: grant.agentId,
          capabilities: await capabilities({
            agentId: grant.agentId,
            threadId: grant.ref,
          }),
          execution: { state: "idle" },
        }
      },
      "older-page": async (command, next) => {
        if (command.sessionId !== grant.ref) throw refused()
        return next(command)
      },
      send: async (command, next) => {
        const scope = await invitedScope(command.sessionId, {
          ...(grant.firstTurnInstruction === undefined
            ? {}
            : { firstTurnInstruction: grant.firstTurnInstruction }),
        })
        if (!scope) throw refused()
        return next({ ...command, scope })
      },
      // A conversation that does not exist yet has no turn to steer.
      steer: async (command, next) => {
        const scope = await invitedScope(command.sessionId)
        if (!scope) throw refused()
        return next({ ...command, scope })
      },
    },
  }
}
