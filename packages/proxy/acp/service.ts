import { randomUUID } from "node:crypto"

import { AcpServer } from "@agentclientprotocol/sdk/experimental/server"

import { Deadline, defaultClock, type Clock } from "../../lifecycle"
import { withinGrace } from "../grace"
import { HANDSHAKE_BUDGET, HANDSHAKE_DEADLINE_MS } from "../core/limits"
import { createAcpSocket, type PublicErrors } from "./socket"
import type { AcpConnectionContext, AosAcpAgentFactory } from "./types"
import type { Role } from "../core/member"

/**
 * The 101 response header that tells the client which connection it got. The
 * SDK reads it back only on its Streamable HTTP transport, which this listener
 * does not host: the proxy mints the id so one value identifies the connection
 * in the header, in the connection context, and in proxy logs.
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
  role: Role
  connectionId: string
  headers: Readonly<Record<string, string>>
}

export type AcpPeer = {
  /**
   * Bun's answer: the bytes written, -1 for a frame queued behind
   * backpressure, or 0 for one dropped, past the backpressure limit or on a
   * socket already closing.
   */
  send(raw: string): number
  /** Whether the socket is open, rather than closing or closed. */
  isOpen(): boolean
  close(code: number, reason: string): void
}

export type AcpServiceOptions = {
  publicOrigin: string
  role: Role
  /** Builds the per-connection ACP agent app. */
  agent: AosAcpAgentFactory
  /** Builds the per-connection proxy state the agent app runs against. */
  connection(connectionId: string, principalId: string): AcpConnectionContext
  /**
   * Who every connection on this listener belongs to. It keys per-operator
   * state the proxy holds outside one connection, so each listener states it
   * rather than letting a role stand in for an identity.
   */
  principalId: string
  /** How this listener shows a failure; as written by default. */
  publicErrors?: PublicErrors
  /**
   * The clock the handshake deadline and the connection machine run on.
   * Uses the default performance clock when absent.
   */
  clock?: Clock
  /**
   * Overrides the handshake deadline duration. Used in tests only; production
   * uses HANDSHAKE_DEADLINE_MS.
   */
  handshakeDeadlineMs?: number
}

/**
 * Hosts one ACP v2 listener over WebSocket as the single normalized connection.
 */
export function createAcpService(options: AcpServiceOptions) {
  const { principalId } = options
  const clock = options.clock ?? defaultClock
  /** The connections open on this listener, which the health gauges count. */
  const connections = new Set<string>()
  /**
   * The connections still in their handshake, at most HANDSHAKE_BUDGET, oldest
   * first, each with the close that evicts it.
   */
  const handshaking = new Map<string, () => void>()

  async function authorizeUpgrade(
    request: Request
  ): Promise<AcpUpgrade | undefined> {
    if (request.headers.get("origin") !== options.publicOrigin) return undefined
    const connectionId = randomUUID()
    return {
      principalId,
      role: options.role,
      connectionId,
      headers: { [CONNECTION_ID_HEADER]: connectionId },
    }
  }

  function open(upgrade: AcpUpgrade, peer: AcpPeer) {
    // Past the handshake budget the oldest socket still in its handshake is
    // closed early, so sockets that never sign in shorten only their own life
    // and a new socket always gets in.
    if (handshaking.size >= HANDSHAKE_BUDGET) {
      const [[oldest, evict]] = handshaking
      handshaking.delete(oldest)
      evict()
    }
    const context = options.connection(
      upgrade.connectionId,
      upgrade.principalId
    )
    // Thread the clock into the context so the connection machine and the
    // handshake deadline share the same injected clock.
    context.clock = clock
    const server = new AcpServer({ createAgent: () => options.agent(context) })
    const prepared = server.prepareWebSocketUpgrade()
    const socket = createAcpSocket({
      close: (code, reason) => peer.close(code, reason),
      send: (raw) => {
        const sent = peer.send(raw)
        if (sent > 0) return
        if (sent < 0) context.logger.debug({}, "acp.send.backpressure")
        // A closing socket drops what is still written to it, as a reloading
        // tab's does; a drop on an open one is a reader past the limit.
        else if (peer.isOpen()) context.logger.warn({}, "acp.send.dropped")
        else context.logger.debug({}, "acp.send.dropped")
      },
      // The upgrade's principal holds for the connection's whole life.
      lapsed: () => context.authentication?.lapsed() ?? false,
      ...(options.publicErrors ? { publicErrors: options.publicErrors } : {}),
    })
    // Arm the handshake deadline: a peer that has not completed its handshake
    // within the deadline, initialize and any login its connection needs, is
    // closed with 4408.
    const deadlineMs = options.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS
    const handshakeDeadline = new Deadline(deadlineMs, clock)
    // Its sign-in or its close frees the socket's handshake slot, not the
    // deadline: a socket still closing holds its peer.
    const handshakeEnded = () => {
      handshaking.delete(upgrade.connectionId)
      handshakeDeadline.clear()
    }
    context.handshakeComplete = handshakeEnded
    const expire = () => socket.socket.close(4408, "Handshake deadline")
    handshakeDeadline.signal.addEventListener("abort", expire, { once: true })
    prepared.accept(socket.socket)
    connections.add(upgrade.connectionId)
    handshaking.set(upgrade.connectionId, () => {
      // One line per eviction, so an operator can see a flood.
      context.logger.warn({}, "acp.handshake.evicted")
      socket.socket.close(4408, "Handshake budget")
    })
    return {
      receive: (raw: string | Uint8Array) => socket.receive(raw),
      close() {
        connections.delete(upgrade.connectionId)
        handshakeEnded()
        socket.close()
        withinGrace(() => server.close(), SERVER_CLOSE_GRACE_MS).catch(
          (err: unknown) =>
            context.logger.warn({ err }, "acp.socket.close_failed")
        )
      },
    }
  }

  return { authorizeUpgrade, open, sockets: () => connections.size }
}
