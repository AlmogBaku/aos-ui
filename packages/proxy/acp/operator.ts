import type { RuntimeInstance, ServerAttachmentStages } from "../core/runtime"
import { createSessionRows } from "../core/session-rows"
import { createActivityFeed } from "./activity-feed"
import { createAosAcpAgent } from "./agent"
import { createReadState } from "./read-state"
import { createAcpService } from "./service"
import * as translators from "./translate"
import type { AcpConnectionContext } from "./types"

export type OperatorAcpServiceOptions = {
  publicOrigin: string
  runtimeInstance: RuntimeInstance
  /** Shared with the HTTP app so prompts can reference REST-staged batches. */
  attachmentStages: ServerAttachmentStages
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
  now = Date.now,
}: OperatorAcpServiceOptions) {
  const lane = "operator" as const
  const sessionRows = createSessionRows({ now })
  return createAcpService({
    publicOrigin,
    lane,
    agent: createAosAcpAgent,
    connection: (connectionId, principalId): AcpConnectionContext => ({
      connectionId,
      principalId,
      lane,
      runtimeInstance,
      sessionRows,
      translators,
      attachmentStages,
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
}
