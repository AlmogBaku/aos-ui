import { randomUUID } from "node:crypto"

import { AcpServer } from "@agentclientprotocol/sdk/experimental/server"

import { withinGrace } from "../grace"
import { createAcpSocket, type AcpSocket, type PublicErrors } from "./socket"
import type { AcpConnectionContext, AosAcpAgentFactory, Lane } from "./types"

/**
 * The 101 response header that tells the client which connection it got. The
 * SDK reads it back only on its Streamable HTTP transport, which this lane does
 * not host: the proxy mints the id so one value identifies the connection in
 * the header, in the connection context, and in proxy logs.
 */
const CONNECTION_ID_HEADER = "Acp-Connection-Id"

/**
 * The SDK's `close` tears down its inbound and outbound streams, which can wait
 * on a handler that is still running, so the proxy bounds that wait instead of
 * letting one connection delay a peer close or a listener shutdown.
 */
const SERVER_CLOSE_GRACE_MS = 1_000

/** One authorized ACP upgrade, carried to `open` through the peer's data. */
export type AcpUpgrade = {
  principalId: string
  lane: Lane
  connectionId: string
  headers: Readonly<Record<string, string>>
}

export type AcpPeer = {
  send(raw: string): void
  close(code: number, reason: string): void
}

export type AcpServiceOptions = {
  publicOrigin: string
  lane: Lane
  /** Builds the per-connection ACP agent app. */
  agent: AosAcpAgentFactory
  /** Builds the per-connection proxy state the agent app runs against. */
  connection(connectionId: string, principalId: string): AcpConnectionContext
  /**
   * Who every connection on this lane belongs to. It keys per-operator state the
   * proxy holds outside one connection, so each lane states it rather than
   * letting a lane name stand in for an identity.
   */
  principalId: string
  /** How this lane shows a failure; as written by default. */
  publicErrors?: PublicErrors
}

/** Hosts one ACP v2 lane over WebSocket as the single normalized connection. */
export function createAcpService(options: AcpServiceOptions) {
  const { principalId } = options

  async function authorizeUpgrade(
    request: Request
  ): Promise<AcpUpgrade | undefined> {
    if (request.headers.get("origin") !== options.publicOrigin) return undefined
    const connectionId = randomUUID()
    return {
      principalId,
      lane: options.lane,
      connectionId,
      headers: { [CONNECTION_ID_HEADER]: connectionId },
    }
  }

  function open(upgrade: AcpUpgrade, peer: AcpPeer) {
    const context = options.connection(
      upgrade.connectionId,
      upgrade.principalId
    )
    const server = new AcpServer({ createAgent: () => options.agent(context) })
    const prepared = server.prepareWebSocketUpgrade()
    const holder: { socket?: AcpSocket } = {}
    const socket = createAcpSocket({
      close: peer.close,
      notify() {
        for (const raw of holder.socket?.drain() ?? []) peer.send(raw)
      },
      // The upgrade's principal holds for the connection's whole life.
      lapsed: () => context.authentication?.lapsed() ?? false,
      ...(options.publicErrors ? { publicErrors: options.publicErrors } : {}),
    })
    holder.socket = socket
    prepared.accept(socket.socket)
    return {
      receive: (raw: string | Uint8Array) => socket.receive(raw),
      close() {
        socket.close()
        void withinGrace(() => server.close(), SERVER_CLOSE_GRACE_MS)
      },
    }
  }

  return { authorizeUpgrade, open }
}

export type AcpService = ReturnType<typeof createAcpService>
