import type { Catalog } from "../../core/catalog"
import {
  CommandRefusedError,
  type MemberScope,
  type Middleware,
} from "../../core/member"
import * as ids from "../../core/ids"
import type { SessionScope } from "../../core/runtime"
import type { GuestGrant } from "./index"

/**
 * The one conversation a guest reaches. A guest addresses it by reference
 * alone, so no other Session is reachable, and the invitation's setup text
 * reaches the runtime only when a Send creates it.
 */

export type GuestScopeOptions = {
  grant: GuestGrant
  catalog: Pick<Catalog, "invited">
}

export function createScopeMiddleware({
  grant,
  catalog,
}: GuestScopeOptions): Middleware {
  const refused = () => new CommandRefusedError("not-found")
  /** The invitation's Session, which a fresh one names before it exists. */
  const addressed: MemberScope = {
    agentId: grant.agentId,
    sessionId: ids.sessionId(grant.ref),
  }

  /** The invited Session as a scope; `undefined` means it does not exist yet. */
  async function invitedScope(
    sessionId: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<SessionScope | undefined> {
    if (sessionId !== grant.ref) throw refused()
    const resolved = await catalog.invited(grant.agentId, grant.ref, create)
    return resolved
      ? { ...addressed, providerSessionId: resolved.providerSessionId }
      : undefined
  }

  return {
    // Nothing about another Session reaches a guest, however it was routed,
    // and nothing about the workspace.
    event: (event) =>
      "sessionId" in event && event.sessionId === grant.ref ? event : undefined,
    commands: {
      // A fresh invitation has no Session yet: resuming it creates nothing and
      // replays nothing, the way the guest history route serves an empty page,
      // and joins it to be shown what it can do. The first Send resolves it.
      resume: async (command, next) => {
        const scope = await invitedScope(command.sessionId)
        return next({ ...command, scope: scope ?? addressed })
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
      stop: async (command, next) => {
        if (command.sessionId !== grant.ref) throw refused()
        return next(command)
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
