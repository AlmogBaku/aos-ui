import type { RuntimeAuthState } from "../../protocol"
import type { OperatorSession } from "../auth/session-cookie"
import type { ServerRuntime } from "../runtime"
import type { ReconnectCursorCodec } from "./cursor"
import { createEventsSocket, type EventsSocket } from "./socket"

export type OperatorEventUpgrade = {
  principalId: string
  browserSessionId: string
  authorizationExpiresAt: number
}

export type OperatorEventPeer = {
  send(raw: string): void
  close(code: number, reason: string): void
}

type EventRuntime = Pick<
  ServerRuntime,
  "resolveSessionId" | "getSession" | "resume" | "observe"
>

export type OperatorEventServiceOptions = {
  publicOrigin: string
  deploymentId: string
  bootEpoch: string
  cursor: ReconnectCursorCodec
  operatorSession(request: Request): Promise<OperatorSession | undefined>
  runtimeState(scope: {
    principalId: string
    lane: "operator"
  }): Promise<RuntimeAuthState> | RuntimeAuthState
  hermesForOperator(principalId: string): EventRuntime
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

/** Authenticates an operator WebSocket before creating invalidation observers. */
export function createOperatorEventService(
  options: OperatorEventServiceOptions
) {
  const now = options.now ?? Date.now

  async function authorizeUpgrade(
    request: Request
  ): Promise<OperatorEventUpgrade | undefined> {
    if (request.headers.get("origin") !== options.publicOrigin) return undefined
    let session: OperatorSession | undefined
    try {
      session = await options.operatorSession(request)
    } catch {
      return undefined
    }
    if (!session || session.expiresAt * 1_000 <= now()) return undefined
    return {
      principalId: session.principalId,
      browserSessionId: session.sessionId,
      authorizationExpiresAt: session.expiresAt * 1_000,
    }
  }

  function open(upgrade: OperatorEventUpgrade, peer: OperatorEventPeer) {
    const hermes = options.hermesForOperator(upgrade.principalId)
    const holder: { socket?: EventsSocket } = {}
    const socket = createEventsSocket({
      cursor: options.cursor,
      now,
      close: peer.close,
      notify() {
        for (const raw of holder.socket?.drain() ?? []) peer.send(raw)
      },
      async authorize({ scope, streamId }) {
        if (
          scope.workspaceId !== "operator" ||
          upgrade.authorizationExpiresAt <= now()
        )
          return null

        const runtimeState = await options.runtimeState({
          principalId: upgrade.principalId,
          lane: "operator",
        })
        if (runtimeState.status !== "authenticated") return null

        try {
          const storedId = hermes.resolveSessionId(
            scope.agentId,
            scope.sessionId
          )
          if (!storedId) return null
          await hermes.getSession(scope.agentId, storedId)
        } catch {
          return null
        }

        return {
          expiresAt: upgrade.authorizationExpiresAt,
          binding: {
            deploymentId: options.deploymentId,
            lane: "operator",
            principalId: upgrade.principalId,
            authorizationRevision: upgrade.browserSessionId,
            scope: canonicalScope(scope),
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            bootEpoch: options.bootEpoch,
            streamId,
          },
        }
      },
      async observe({ scope, invalidate, reset }) {
        const sessionId = hermes.resolveSessionId(
          scope.agentId,
          scope.sessionId
        )
        if (!sessionId) throw new Error("Invalid Session scope")
        const { liveSessionId } = await hermes.resume({
          agentId: scope.agentId,
          sessionId,
          threadId: scope.sessionId,
        })
        const stop = await hermes.observe(
          liveSessionId,
          () => invalidate(),
          () => reset()
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
