import {
  SessionWorkspaceCapabilitiesResponseSchema,
  type SessionHistoryResponse,
} from "../../protocol"
import { createAosAcpAgent } from "../acp/agent"
import { createReadState } from "../acp/read-state"
import { createAcpService } from "../acp/service"
import type { SessionRooms } from "../acp/session-rooms"
import * as translators from "../acp/translate"
import type {
  AcpConnectionContext,
  AcpLogger,
  GuestGrant,
  GuestPolicy,
  WorkspaceCapabilities,
} from "../acp/types"
import { authenticationRequired, invalidRequest } from "../acp/validation"
import type {
  GuestInvitationService,
  VerifiedGuestAuthorization,
} from "../auth/guest-invitation"
import {
  createGuestRequestAuthorizer,
  guestAuthorizationActive,
  guestControllerId,
} from "../auth/guest-request"
import {
  createGuestTurnAccess,
  projectGuestCapabilities,
  projectGuestHistory,
  projectGuestText,
} from "../auth/guest-runtime-projection"
import { PendingRequestKind } from "../core/events"
import type { RuntimeInstance, ServerAttachmentStages } from "../core/runtime"
import { createSessionRows, type SessionRows } from "../core/session-rows"

/**
 * The guest lane's ACP service: one invited conversation per connection, with
 * the same invitation authorization and output projection the guest REST routes
 * apply. The lane's principal is the invitation, so every per-connection
 * authorization lives in its `GuestPolicy` rather than in the upgrade.
 */

export type GuestAcpServiceOptions = {
  publicOrigin: string
  runtimeInstance: RuntimeInstance
  invitations: GuestInvitationService
  /** Shared with the guest HTTP app so prompts can reference staged batches. */
  attachmentStages: ServerAttachmentStages
  /** The one room registry the operator lane shares, so both see one room. */
  rooms: SessionRooms
  /** Where this lane's connections write their structured lines. */
  logger?: AcpLogger
  now?: () => number
  schedule?: (delayMs: number, task: () => void) => unknown
  cancel?: (timer: unknown) => void
}

/** What a guest may observe but never operate, in the shape ACP carries. */
const OPERATOR_ONLY = {
  status: "unavailable",
  reason: "operator-session-controls-required",
} as const

/** The approval scopes the guest lane never carries, as the adapters name them. */
const GUEST_DENIED_CHOICES = new Set(["always", "session"])

/**
 * The invited Session's capabilities, projected to what the guest lane serves.
 * The ACP contract carries the workspace shape, so the fields the REST
 * projection drops outright are reported unavailable here instead.
 */
function projectCapabilities(
  value: WorkspaceCapabilities
): WorkspaceCapabilities {
  const projected = projectGuestCapabilities(value)
  if (!projected)
    throw new Error("The invited Session reported unusable capabilities")
  return SessionWorkspaceCapabilitiesResponseSchema.parse({
    workspace: {
      slashCommands: projected.workspace.slashCommands,
      models: OPERATOR_ONLY,
      context: OPERATOR_ONLY,
      todos: value.workspace.todos,
      activity: value.workspace.activity,
    },
    interactions: projected.interactions,
    content: projected.content,
  })
}

type Redeemed = {
  grant: GuestGrant
  read: VerifiedGuestAuthorization
  errors: VerifiedGuestAuthorization
}

/**
 * One connection's invitation. Nothing is projected before `auth/login`
 * redeems a token, and the redeemed grant carries the controller identity the
 * coordinator already knows guests by.
 */
function createGuestPolicy(options: GuestAcpServiceOptions): GuestPolicy {
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
  let redeemed: Redeemed | undefined
  let close: (() => void) | undefined
  let timer: unknown

  const arm = () => {
    if (!redeemed || !close) return
    const delayMs = redeemed.grant.expiresAt - now()
    if (delayMs <= 0) return close()
    timer = schedule(delayMs, () => close?.())
  }

  const authorized = () => {
    if (!redeemed) throw authenticationRequired()
    return redeemed
  }

  return {
    async authenticate(token) {
      const identity = await options.invitations.verify(token)
      if (!identity || !guestAuthorizationActive(identity, now))
        return undefined
      const target = { agentId: identity.agentId, sessionId: identity.ref }
      const read = authorizer.authorize(identity, {
        ...target,
        operation: "messages:read",
      })
      const errors = authorizer.authorize(identity, {
        ...target,
        operation: "errors:read",
      })
      if (!read || !errors) return undefined
      const grant: GuestGrant = {
        agentId: identity.agentId,
        ref: identity.ref,
        principalId: guestControllerId(read),
        expiresAt: identity.authorizationExpiresAt * 1_000,
        ...(identity.firstTurn?.instruction
          ? { firstTurnInstruction: identity.firstTurn.instruction }
          : {}),
      }
      redeemed = { grant, read, errors }
      arm()
      return grant
    },

    grant: () => redeemed?.grant,

    project: {
      access(base, scope) {
        const { read, errors } = authorized()
        return createGuestTurnAccess(
          read,
          errors,
          scope,
          now,
          base.subscriberId
        )
      },
      history(value: SessionHistoryResponse) {
        const { read, grant } = authorized()
        return projectGuestHistory(value, read, grant.ref)
      },
      turn(text) {
        const { read } = authorized()
        return guestAuthorizationActive(read, now)
          ? projectGuestText(read, "guest", text)
          : undefined
      },
      capabilities: projectCapabilities,
      permissionReply(request, reply) {
        authorized()
        // Mirrors `guestResumeAllowed`: an answer may not carry a Session-wide
        // or Agent-wide approval even when the guest client names one.
        if (
          request.kind === PendingRequestKind.Permission &&
          typeof reply.payload === "string" &&
          GUEST_DENIED_CHOICES.has(reply.payload)
        )
          throw invalidRequest()
        return reply
      },
    },

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
 * One accepted guest connection: its own invitation policy and read-state
 * service (inert on this lane). It carries no activity feed, which would
 * describe the Agent's other Sessions.
 */
export function createGuestConnection(
  options: GuestAcpServiceOptions,
  sessionRows: SessionRows,
  connectionId: string
): AcpConnectionContext {
  const lane = "guest" as const
  const now = options.now ?? Date.now
  const { runtimeInstance } = options
  const guest = createGuestPolicy(options)
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
    guest,
    readState: createReadState({
      runtimeInstance,
      sessionRows,
      lane,
      now,
      onUnreadChanged: () => undefined,
    }),
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
    connection: (connectionId) =>
      createGuestConnection(options, sessionRows, connectionId),
  })
  // Exposed so the composition can show both lanes hold the same registry.
  return { ...service, rooms: options.rooms }
}
