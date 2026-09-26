import type { Catalog } from "../core/catalog"
import { OPERATOR_PRINCIPAL } from "../core/principal"
import type { RuntimeInstance, ServerAttachmentStages } from "../core/runtime"
import type { PresenceRegistry } from "../push/presence"
import { createActivityFeed } from "./activity-feed"
import { createAosAcpAgent } from "./agent"
import { createReadState } from "./read-state"
import { createAcpService } from "./service"
import type { Channels } from "../core/channel"
import * as translators from "./translate"
import type { AcpConnectionContext, AcpLogger } from "./types"

export type OperatorAcpServiceOptions = {
  publicOrigin: string
  runtimeInstance: RuntimeInstance
  /** Shared with the HTTP app so prompts can reference REST-staged batches. */
  attachmentStages: ServerAttachmentStages
  /** The channels the guest listener shares, so both see one per Session. */
  channels: Channels
  /** Where this listener's connections write their structured lines. */
  logger?: AcpLogger
  /** Shared with push delivery; absent means nothing observes presence. */
  presence?: PresenceRegistry
  /** The workspace catalog the guest listener shares, with its row cache. */
  catalog: Catalog
  /** The browser build the static root carries; absent without one. */
  buildId?: string
  now?: () => number
}

/**
 * The operator listener's ACP service: the deployment's one catalog and
 * activity feed, which each connection opens once initialized, and per
 * accepted connection its own read-state service.
 */
export function createOperatorAcpService({
  publicOrigin,
  runtimeInstance,
  attachmentStages,
  channels,
  logger,
  presence,
  catalog,
  buildId,
  now = Date.now,
}: OperatorAcpServiceOptions) {
  const role = "operator" as const
  const activityFeed = createActivityFeed({
    catalog,
    coordinator: runtimeInstance.sessions,
    now,
  })
  const service = createAcpService({
    publicOrigin,
    role,
    principalId: OPERATOR_PRINCIPAL,
    agent: createAosAcpAgent,
    connection: (connectionId, principalId): AcpConnectionContext => ({
      connectionId,
      principalId,
      role,
      publicError: (cause) => runtimeInstance.runtime.publicError(cause),
      steerAck: runtimeInstance.runtime.translation?.steerAck,
      catalog,
      translators,
      attachmentStages,
      channels,
      logger,
      presence,
      buildId,
      readState: createReadState({
        catalog,
        relighting: runtimeInstance.runtime.translation?.relighting,
        now,
        // The agent already projects every changed row to its connection.
        onUnreadChanged: () => undefined,
      }),
      activityFeed,
    }),
  })
  // The cache is part of the listener's surface: push delivery gates on the
  // rows this listener keeps current, and there is only ever one of them. The
  // channels are exposed alike, so the composition can show both listeners
  // share them.
  return { ...service, sessionRows: catalog.rows, channels }
}
