import { OPERATOR_PRINCIPAL } from "../core/principal"
import type { RuntimeInstance, ServerAttachmentStages } from "../core/runtime"
import { createSessionRows, type SessionRows } from "../core/session-rows"
import type { PresenceRegistry } from "../push/presence"
import { createActivityFeed } from "./activity-feed"
import { createAosAcpAgent } from "./agent"
import { createReadState } from "./read-state"
import { createAcpService } from "./service"
import * as translators from "./translate"
import type { AcpConnectionContext, AcpLogger } from "./types"

export type OperatorAcpServiceOptions = {
  publicOrigin: string
  runtimeInstance: RuntimeInstance
  /** Shared with the HTTP app so prompts can reference REST-staged batches. */
  attachmentStages: ServerAttachmentStages
  /** Where this lane's connections write their structured lines. */
  logger?: AcpLogger
  /** Shared with push delivery; absent means nothing observes presence. */
  presence?: PresenceRegistry
  /**
   * The row cache this lane maintains. Push delivery reads the same one to gate
   * a notification on read state; absent means this lane owns the only cache.
   */
  sessionRows?: SessionRows
  now?: () => number
}

/**
 * The operator lane's ACP service: one Session row cache per deployment and,
 * per accepted connection, its own read-state service and activity feed.
 */
export function createOperatorAcpService({
  publicOrigin,
  runtimeInstance,
  attachmentStages,
  logger,
  presence,
  now = Date.now,
  sessionRows = createSessionRows({ now }),
}: OperatorAcpServiceOptions) {
  const lane = "operator" as const
  const service = createAcpService({
    publicOrigin,
    lane,
    principalId: OPERATOR_PRINCIPAL,
    agent: createAosAcpAgent,
    connection: (connectionId, principalId): AcpConnectionContext => ({
      connectionId,
      principalId,
      lane,
      runtimeInstance,
      sessionRows,
      translators,
      attachmentStages,
      logger,
      presence,
      readState: createReadState({
        runtimeInstance,
        sessionRows,
        lane,
        now,
        // The agent already projects every changed row to its connection.
        onUnreadChanged: () => undefined,
      }),
      activityFeed: createActivityFeed({ runtimeInstance, sessionRows, now }),
    }),
  })
  // The cache is part of the lane's surface: push delivery gates on the rows
  // this lane keeps current, and there is only ever one of them.
  return { ...service, sessionRows }
}
