import type { Middleware } from "../../core/member"
import { createCommandsMiddleware } from "./commands"
import { createHistoryMiddleware } from "./history"
import { createPermissionsMiddleware } from "./permissions"
import { createScopeMiddleware, type GuestScopeOptions } from "./scope"
import { createTurnsMiddleware } from "./turns"

/**
 * One redeemed invitation, shaped after the claims `GuestInvitationService`
 * verifies: the single Agent and conversation reference it grants, the
 * controller identity the coordinator already knows this guest by, and the
 * moment the connection must close.
 */
export type GuestGrant = {
  agentId: string
  ref: string
  principalId: string
  /** Unix milliseconds; the connection closes when it passes. */
  expiresAt: number
  /** Non-secret setup text the runtime receives once, on creation. */
  firstTurnInstruction?: string
}

export type GuestMiddlewareOptions = GuestScopeOptions

/**
 * A guest member's stack, outermost first. A refused command never reaches
 * scope, so a refused first Send never creates the conversation, and the
 * commands layer projects what a resume answers last on the way out.
 */
export function createGuestMiddleware(
  options: GuestMiddlewareOptions
): readonly Middleware[] {
  return [
    createCommandsMiddleware(),
    createScopeMiddleware(options),
    createHistoryMiddleware(options),
    createTurnsMiddleware(),
    createPermissionsMiddleware({ principalId: options.grant.principalId }),
  ]
}
