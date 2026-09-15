import type { RuntimeInstance } from "../core/runtime"
import type { ReconnectCursorCodec } from "./cursor"
import { createEventsSocket, type EventsSocket } from "./socket"

export type OperatorEventUpgrade = {
  principalId: "operator"
  authorizationRevision: "trusted-listener"
}

export type OperatorEventPeer = {
  send(raw: string): void
  close(code: number, reason: string): void
}

export type OperatorEventServiceOptions = {
  publicOrigin: string
  deploymentId: string
  bootEpoch: string
  cursor: ReconnectCursorCodec
  runtimeInstance: RuntimeInstance
  now?: () => number
}

function canonicalScope(scope: {
  workspaceId: string
  agentId: string
  sessionId: string
}) {
  const encode = (value: string) =>
    Buffer.from(value, "utf8").toString("base64url")
  return `ws1.${encode(scope.workspaceId)}.${encode(scope.agentId)}.${encode(scope.sessionId)}`
}

/** Trusted operator listener with provider-neutral Session invalidations. */
export function createOperatorEventService(
  options: OperatorEventServiceOptions
) {
  async function authorizeUpgrade(
    request: Request
  ): Promise<OperatorEventUpgrade | undefined> {
    if (request.headers.get("origin") !== options.publicOrigin) return undefined
    return {
      principalId: "operator",
      authorizationRevision: "trusted-listener",
    }
  }

  function open(upgrade: OperatorEventUpgrade, peer: OperatorEventPeer) {
    const runtime = options.runtimeInstance.runtime
    const holder: { socket?: EventsSocket } = {}
    const socket = createEventsSocket({
      cursor: options.cursor,
      ...(options.now === undefined ? {} : { now: options.now }),
      close: peer.close,
      notify() {
        for (const raw of holder.socket?.drain() ?? []) peer.send(raw)
      },
      async authorize({ scope, streamId }) {
        if (scope.workspaceId !== "operator") return null
        try {
          const storedId = runtime.resolveSessionId(
            scope.agentId,
            scope.sessionId
          )
          if (!storedId) return null
          await runtime.getSession(scope.agentId, storedId)
        } catch {
          return null
        }
        return {
          binding: {
            deploymentId: options.deploymentId,
            lane: "operator",
            principalId: upgrade.principalId,
            authorizationRevision: upgrade.authorizationRevision,
            scope: canonicalScope(scope),
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            bootEpoch: options.bootEpoch,
            streamId,
          },
        }
      },
      async observe({ scope, invalidate, reset }) {
        const stop = await runtime.subscribeSessionInvalidation(
          scope.agentId,
          scope.sessionId,
          invalidate,
          reset
        )
        return { stop }
      },
    })
    holder.socket = socket
    return socket
  }

  return { authorizeUpgrade, open }
}

export type OperatorEventService = ReturnType<typeof createOperatorEventService>
