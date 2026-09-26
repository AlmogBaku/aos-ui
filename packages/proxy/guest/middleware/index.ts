import type { Middleware } from "../../core/member"
import { createCommandsMiddleware } from "./commands"
import { createFeedsMiddleware } from "./feeds"
import { createHistoryMiddleware } from "./history"
import { createPermissionsMiddleware } from "./permissions"
import { createQuotaMiddleware } from "./quota"
import { createScopeMiddleware, type GuestScopeOptions } from "./scope"
import { createTurnsMiddleware } from "./turns"

/**
 * One redeemed invitation, shaped after the claims `GuestInvitationService`
 * verifies: the single Agent and conversation reference it grants, the
 * principal this guest acts as, and the moment the connection must close.
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

export type GuestMiddlewareOptions = GuestScopeOptions & {
  /** How many turns every guest together may hold at once. */
  guestActiveExecutions: number
}

/**
 * A guest member's stack, outermost first. A refused command never reaches
 * scope, so a refused first Send never creates the conversation, and the
 * commands layer projects the commands event last on the way out.
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
    createFeedsMiddleware(),
    createQuotaMiddleware({ limit: options.guestActiveExecutions }),
  ]
}
