import type { Logger } from "../lifecycle"
import { sleep, withinGrace } from "./grace"

type FetchHandler = (
  request: Request,
  server?: unknown
) => Response | undefined | Promise<Response | undefined>
type Server = {
  stop(closeActiveConnections?: boolean): Promise<void> | void
  /** Bun's in-flight request count; absent when a caller fakes the listener. */
  readonly pendingRequests?: number
}

/** How often shutdown re-reads the listener's in-flight request count. */
const DRAIN_POLL_MS = 10

/**
 * Bun WebSocket server options applied to every mount. These match the Values
 * table: idleTimeout 120 s, sendPings, 1.1 MB frame cap, 16 MiB backpressure
 * limit, and automatic close when that limit is exceeded.
 */
const WS_IDLE_TIMEOUT_S = 120
const WS_MAX_PAYLOAD = 1_100_000
const WS_BACKPRESSURE_LIMIT = 16 * 1_024 * 1_024
/** A WebSocket's `readyState` while it is open. */
const WS_OPEN = 1

/** One authorized upgrade: its principal and any headers the 101 must carry. */
export type SocketUpgrade = {
  principalId: string
  headers?: Readonly<Record<string, string>>
}

/**
 * An upgrade the service answers with a status instead: 404 for an address it
 * does not serve, 503 when it cannot tell now.
 */
export type SocketRefusal = { refused: 404 | 503 }

/** The transport-neutral socket a mounted service owns for one peer. */
export type ProxySocket = {
  receive(raw: string | Uint8Array): void | Promise<void>
  close(): void
}

export type ProxySocketPeer = {
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

export type ProxySocketService<Upgrade extends SocketUpgrade> = {
  /** The upgrade, its refusal, or `undefined` for an unauthorized one. */
  authorizeUpgrade(
    request: Request
  ): Promise<Upgrade | SocketRefusal | undefined>
  open(upgrade: Upgrade, peer: ProxySocketPeer): ProxySocket
}

/** One WebSocket path hosted beside the HTTP app, with its own peer budget. */
export type ProxySocketMount<Upgrade extends SocketUpgrade> = {
  path: string
  /**
   * Also routes every path below `path` to the service, which refuses one it
   * does not serve.
   */
  subpaths?: boolean
  service: ProxySocketService<Upgrade>
  maxPeers?: number
}

type MountState<Upgrade extends SocketUpgrade> = {
  path: string
  subpaths: boolean
  service: ProxySocketService<Upgrade>
  maxPeers: number
  peers: Set<SocketPeer<Upgrade>>
  reserved: number
}
type SocketData<Upgrade extends SocketUpgrade> = {
  mount: MountState<Upgrade>
  authorization: Upgrade
  socket?: ProxySocket
  failed?: boolean
  overloaded?: boolean
  /** Bun ran this peer's close handler, which it does inside the close call. */
  closed?: boolean
}
type SocketPeer<Upgrade extends SocketUpgrade> = {
  data: SocketData<Upgrade>
  readonly readyState: number
  send(raw: string): number
  close(code?: number, reason?: string): void
}
type UpgradeServer = {
  upgrade<Upgrade extends SocketUpgrade>(
    request: Request,
    options: {
      data: SocketData<Upgrade>
      headers?: Readonly<Record<string, string>>
    }
  ): boolean
}
type ServeOptions<Upgrade extends SocketUpgrade> = {
  hostname: string
  port: number
  fetch: FetchHandler
  websocket?: {
    idleTimeout?: number
    sendPings?: boolean
    maxPayloadLength?: number
    backpressureLimit?: number
    closeOnBackpressureLimit?: boolean
    open(peer: SocketPeer<Upgrade>): void
    message(
      peer: SocketPeer<Upgrade>,
      raw: string | Uint8Array | ArrayBuffer
    ): void
    close(peer: SocketPeer<Upgrade>): void
  }
}
type Serve = <Upgrade extends SocketUpgrade>(
  options: ServeOptions<Upgrade>
) => Server

/** How one listener's shutdown ended, for the owner that decides the exit. */
export type ShutdownSettlement = {
  /** The grace expired before the listener drained: the exit is unclean. */
  forced: boolean
}

export type StartProxyServerOptions<
  Upgrade extends SocketUpgrade = SocketUpgrade,
> = {
  app: { fetch: FetchHandler }
  /** WebSocket mounts hosted beside the HTTP app, each with its own peer budget. */
  sockets?: readonly ProxySocketMount<Upgrade>[]
  host: string
  port: number
  /** Bounds the whole shutdown sequence, however the shutdown was triggered. */
  shutdownGraceMs: number
  close?: () => Promise<void> | void
  /** Observes entry into shutdown, before any bounded wait begins. */
  onShutdownStarted?: () => void
  /** Observes the one settlement of this listener's shutdown. */
  onSettled?: (settlement: ShutdownSettlement) => void
  serve?: Serve
  installSignalHandlers?: boolean
  /** Logs socket and peer failures; silent when absent. */
  logger?: Logger
}

function bunServe(): Serve {
  const bun = (globalThis as unknown as { Bun?: { serve: Serve } }).Bun
  if (!bun) throw new Error("Bun runtime is required")
  return bun.serve.bind(bun)
}

function mountState<Upgrade extends SocketUpgrade>(
  mount: ProxySocketMount<Upgrade>
): MountState<Upgrade> {
  const maxPeers = mount.maxPeers ?? Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(maxPeers) || maxPeers < 1)
    throw new Error("Invalid socket peer limit")
  return {
    path: mount.path,
    subpaths: mount.subpaths ?? false,
    service: mount.service,
    maxPeers,
    peers: new Set(),
    reserved: 0,
  }
}

export function startProxyServer<Upgrade extends SocketUpgrade = SocketUpgrade>(
  options: StartProxyServerOptions<Upgrade>
) {
  const mounts = (options.sockets ?? []).map((mount) => mountState(mount))
  const { logger } = options
  const failPeer = (peer: SocketPeer<Upgrade>, cause?: unknown) => {
    if (peer.data.failed) return
    peer.data.failed = true
    if (cause !== undefined) logger?.error({ err: cause }, "acp.peer.failed")
    try {
      peer.data.socket?.close()
    } catch {
      // Peer failure cleanup is best-effort.
    }
    peer.data.socket = undefined
    try {
      peer.close(1011, "Event connection failed")
    } catch {
      // The peer may already be gone.
    }
  }
  const websocket =
    mounts.length > 0
      ? {
          idleTimeout: WS_IDLE_TIMEOUT_S,
          sendPings: true,
          maxPayloadLength: WS_MAX_PAYLOAD,
          backpressureLimit: WS_BACKPRESSURE_LIMIT,
          closeOnBackpressureLimit: true,
          open(peer: SocketPeer<Upgrade>) {
            const mount = peer.data.mount
            if (mount.reserved > 0) mount.reserved -= 1
            if (peer.data.overloaded) {
              peer.close(1013, "Event peer capacity exceeded")
              return
            }
            try {
              const socket = mount.service.open(peer.data.authorization, {
                send: (raw) => peer.send(raw),
                isOpen: () => peer.readyState === WS_OPEN,
                close: (code, reason) => peer.close(code, reason),
              })
              // A service that closed its own peer while opening it has run
              // the close handler already, so the peer is never counted.
              if (peer.data.closed) {
                socket.close()
                return
              }
              peer.data.socket = socket
              mount.peers.add(peer)
            } catch (cause) {
              failPeer(peer, cause)
            }
          },
          message(
            peer: SocketPeer<Upgrade>,
            raw: string | Uint8Array | ArrayBuffer
          ) {
            const frame = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
            void Promise.resolve()
              .then(() => peer.data.socket?.receive(frame))
              .catch((cause: unknown) => failPeer(peer, cause))
          },
          close(peer: SocketPeer<Upgrade>) {
            peer.data.closed = true
            peer.data.mount.peers.delete(peer)
            try {
              peer.data.socket?.close()
            } catch {
              // Concrete peer close must still finish cleanup.
            }
            peer.data.socket = undefined
          },
        }
      : undefined
  const fetch: FetchHandler = async (request, rawServer) => {
    const url = new URL(request.url)
    const mount = mounts.find(
      ({ path, subpaths }) =>
        url.pathname === path ||
        (subpaths && url.pathname.startsWith(`${path}/`))
    )
    if (mount) {
      if (request.method !== "GET") return new Response(null, { status: 405 })
      const authorization = await mount.service.authorizeUpgrade(request)
      if (!authorization) return new Response(null, { status: 401 })
      if ("refused" in authorization)
        return new Response(null, { status: authorization.refused })
      const upgrade = rawServer as UpgradeServer | undefined
      const overloaded = mount.peers.size + mount.reserved >= mount.maxPeers
      if (!overloaded) mount.reserved += 1
      if (
        !upgrade?.upgrade(request, {
          data: { mount, authorization, overloaded },
          ...(authorization.headers === undefined
            ? {}
            : { headers: authorization.headers }),
        })
      ) {
        if (!overloaded) mount.reserved -= 1
        return new Response(null, { status: 500 })
      }
      return undefined
    }
    return options.app.fetch(request, rawServer)
  }
  const server = (options.serve ?? bunServe())({
    hostname: options.host,
    port: options.port,
    fetch,
    ...(websocket === undefined ? {} : { websocket }),
  })
  let shutdownPromise: Promise<void> | undefined
  let onSignal: (() => void) | undefined
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    options.onShutdownStarted?.()
    for (const mount of mounts) {
      for (const peer of mount.peers) {
        try {
          peer.data.socket?.close()
        } catch {
          // Shutdown continues even if observer cleanup has already failed.
        }
        peer.data.socket = undefined
        try {
          peer.close(1001, "Server shutting down")
        } catch {
          // The peer may already be gone.
        }
      }
      mount.peers.clear()
    }
    if (onSignal) {
      process.removeListener("SIGINT", onSignal)
      process.removeListener("SIGTERM", onSignal)
      onSignal = undefined
    }
    shutdownPromise = (async () => {
      // One deadline covers the whole sequence: a request that will not finish
      // and a provider that will not close must not outlive the grace.
      const deadlineAt = Date.now() + options.shutdownGraceMs
      const remainingMs = () => Math.max(0, deadlineAt - Date.now())
      let forced = false
      // Stop accepting new work. Bun leaves this promise pending until every
      // connection is gone and never settles it once a peer has been upgraded,
      // so nothing waits on it and the drain below reads the request count.
      Promise.resolve()
        .then(() => server.stop(false))
        .catch((err: unknown) => logger?.warn({ err }, "server.stop.failed"))
      const inFlight = () => server.pendingRequests ?? 0
      while (inFlight() > 0 && remainingMs() > 0)
        await sleep(Math.min(DRAIN_POLL_MS, remainingMs()))
      if (inFlight() > 0) forced = true
      // Peers are closed and requests are drained or abandoned, so release the
      // listener itself: Bun frees a hosted socket only on a forced stop.
      await withinGrace(() => server.stop(true), remainingMs())
      if (!(await withinGrace(() => options.close?.(), remainingMs())))
        forced = true
      options.onSettled?.({ forced })
    })()
    return shutdownPromise
  }

  if (options.installSignalHandlers !== false) {
    onSignal = () => {
      shutdown().catch((err: unknown) =>
        logger?.warn({ err }, "server.shutdown.failed")
      )
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  }
  return { server, shutdown }
}
