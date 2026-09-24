import { createAosAcpAgent } from "../acp/agent"
import { createWorkspace, type Workspace } from "../acp/agent-sessions"
import { createAcpService } from "../acp/service"
import type { Channel } from "../core/channel"
import type { Member } from "../core/member"
import * as translators from "../acp/translate"
import type {
  AcpConnectionContext,
  AcpLogger,
  ConnectionAuthentication,
} from "../acp/types"
import { PUBLIC_ERRORS } from "../acp/validation"
import type { GuestInvitationService } from "../auth/guest-invitation"
import {
  createGuestRequestAuthorizer,
  guestAuthorizationActive,
  guestControllerId,
} from "../auth/guest-request"
import type { RuntimeInstance, ServerAttachmentStages } from "../core/runtime"
import { createSessionRows, type SessionRows } from "../core/session-rows"
import { AOS_AUTH_METHOD_INVITE, type AosExtensions } from "../../protocol/acp"
import { createGuestMiddleware, type GuestGrant } from "./middleware"

/**
 * The guest lane's ACP service: one invited conversation per connection, with
 * the same invitation authorization and output projection the guest REST routes
 * apply. The lane's principal is the invitation, so every per-connection
 * authorization lives in its authentication rather than in the upgrade.
 */

export type GuestAcpServiceOptions = {
  publicOrigin: string
  runtimeInstance: RuntimeInstance
  invitations: GuestInvitationService
  /** Shared with the guest HTTP app so prompts can reference staged batches. */
  attachmentStages: ServerAttachmentStages
  /** The one room registry the operator lane shares, so both see one room. */
  rooms: Channel
  /** Where this lane's connections write their structured lines. */
  logger?: AcpLogger
  now?: () => number
  schedule?: (delayMs: number, task: () => void) => unknown
  cancel?: (timer: unknown) => void
}

/**
 * The guest lane holds one invited conversation and manages no workspace: it
 * owns no roster, no read state, and no catalog. It steers, edits, retries,
 * and takes the runtime's prefill as an operator does.
 */
const GUEST_EXTENSIONS = {
  steer: true,
  rewind: true,
  composerPrefill: true,
  agents: false,
  invalidation: false,
  activity: false,
  readState: false,
  focus: false,
  guestProjection: true,
  historyPages: true,
} satisfies AosExtensions

/** The longest delay one timer holds; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

const INVITE_AUTH_METHOD = {
  type: "agent",
  methodId: AOS_AUTH_METHOD_INVITE,
  name: "Invitation",
} as const

/**
 * One connection's invitation. Nothing is reachable before `auth/login`
 * redeems a token, and the redeemed member acts as the controller identity the
 * coordinator already knows guests by, through the guest middleware.
 */
function createGuestAuthentication(
  options: GuestAcpServiceOptions,
  workspace: Pick<Workspace, "invited" | "capabilities">
): ConnectionAuthentication {
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((delayMs: number, task: () => void) => setTimeout(task, delayMs))
  const cancel =
    options.cancel ?? ((timer: unknown) => clearTimeout(timer as number))
  const authorizer = createGuestRequestAuthorizer({
    runtimeId: options.runtimeInstance.id,
    invitations: options.invitations,
    now,
  })
  let redeemed:
    { grant: GuestGrant; member: Omit<Member, "connection"> } | undefined
  let close: (() => void) | undefined
  let timer: unknown

  const lapsed = () =>
    redeemed !== undefined && now() >= redeemed.grant.expiresAt

  /** Waits for the expiry in steps, since a longer timer fires at once. */
  const arm = () => {
    if (!redeemed || !close) return
    const delayMs = redeemed.grant.expiresAt - now()
    if (delayMs <= 0) return close()
    timer = schedule(Math.min(delayMs, MAX_TIMER_MS), arm)
  }

  return {
    authMethods: [INVITE_AUTH_METHOD],
    extensions: GUEST_EXTENSIONS,

    async authenticate(token) {
      const identity = await options.invitations.verify(token)
      if (!identity || !guestAuthorizationActive(identity, now)) return false
      const target = { agentId: identity.agentId, sessionId: identity.ref }
      const read = authorizer.authorize(identity, {
        ...target,
        operation: "messages:read",
      })
      const errors = authorizer.authorize(identity, {
        ...target,
        operation: "errors:read",
      })
      if (!read || !errors) return false
      const grant: GuestGrant = {
        agentId: identity.agentId,
        ref: identity.ref,
        principalId: guestControllerId(read),
        expiresAt: identity.authorizationExpiresAt * 1_000,
        ...(identity.firstTurn?.instruction
          ? { firstTurnInstruction: identity.firstTurn.instruction }
          : {}),
      }
      // A connection acts as one invitation for its whole life.
      if (redeemed) return false
      redeemed = {
        grant,
        member: {
          principal: { id: grant.principalId, role: "guest" },
          middleware: createGuestMiddleware({
            grant,
            invited: workspace.invited,
            capabilities: workspace.capabilities,
          }),
        },
      }
      arm()
      return true
    },

    member: () => redeemed?.member,

    live: () => redeemed !== undefined && !lapsed(),

    lapsed,

    expire(closeConnection) {
      close = closeConnection
      arm()
      return () => {
        close = undefined
        if (timer !== undefined) cancel(timer)
        timer = undefined
      }
    },
  }
}

/**
 * One accepted guest connection and its own invitation. It carries no
 * activity feed, which would describe the Agent's other Sessions, and no read
 * state, which is the operator's.
 */
export function createGuestConnection(
  options: GuestAcpServiceOptions,
  sessionRows: SessionRows,
  connectionId: string
): AcpConnectionContext {
  const lane = "guest" as const
  const { runtimeInstance } = options
  const authentication = createGuestAuthentication(
    options,
    createWorkspace({ runtimeInstance, sessionRows, principalId: lane })
  )
  return {
    connectionId,
    // The connection's real principal arrives with its redeemed invitation.
    principalId: lane,
    lane,
    runtimeInstance,
    sessionRows,
    translators,
    attachmentStages: options.attachmentStages,
    rooms: options.rooms,
    logger: options.logger,
    // A guest is given no feed: no reading, activity, read state, Session row
    // or catalog signal.
    feeds: new Set(),
    authentication,
  }
}

/**
 * Hosts the guest lane on its own listener path, with one Session row cache per
 * deployment behind the per-connection invitations.
 */
export function createGuestAcpService(options: GuestAcpServiceOptions) {
  const lane = "guest" as const
  const sessionRows = createSessionRows({ now: options.now ?? Date.now })
  const service = createAcpService({
    publicOrigin: options.publicOrigin,
    lane,
    principalId: lane,
    agent: createAosAcpAgent,
    // A guest reads a failure's public code, never what the host knows of it.
    publicErrors: PUBLIC_ERRORS,
    connection: (connectionId) =>
      createGuestConnection(options, sessionRows, connectionId),
  })
  // Exposed so the composition can show both lanes hold the same registry.
  return { ...service, rooms: options.rooms }
}
