import type { OperatorEventUpgrade } from "./events/service"

/** Where the operator invalidation socket is mounted. */
const OPERATOR_EVENTS_PATH = "/api/aos/v1/events"

type FetchHandler = (
  request: Request,
  server?: unknown
) => Response | undefined | Promise<Response | undefined>
type Server = { stop(closeActiveConnections?: boolean): Promise<void> | void }

/** One authorized upgrade: its principal and any headers the 101 must carry. */
export type SocketUpgrade = {
  principalId: string
  headers?: Readonly<Record<string, string>>
}

/** The transport-neutral socket a mounted service owns for one peer. */
export type ProxySocket = {
  receive(raw: string | Uint8Array): void | Promise<void>
  close(): void
}

export type ProxySocketPeer = {
  send(raw: string): void
  close(code: number, reason: string): void
}

export type ProxySocketService<Upgrade extends SocketUpgrade> = {
  authorizeUpgrade(request: Request): Promise<Upgrade | undefined>
  open(upgrade: Upgrade, peer: ProxySocketPeer): ProxySocket
}

/** One WebSocket path hosted beside the HTTP app, with its own peer budget. */
export type ProxySocketMount<Upgrade extends SocketUpgrade> = {
  path: string
  service: ProxySocketService<Upgrade>
  maxPeers?: number
}

type MountState<Upgrade extends SocketUpgrade> = {
  path: string
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
}
type SocketPeer<Upgrade extends SocketUpgrade> = {
  data: SocketData<Upgrade>
  send(raw: string): void
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
type RequestServer = UpgradeServer & {
  timeout?(request: Request, seconds: number): void
}
type ServeOptions<Upgrade extends SocketUpgrade> = {
  hostname: string
  port: number
  fetch: FetchHandler
  websocket?: {
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

export type StartProxyServerOptions<
  Upgrade extends SocketUpgrade = OperatorEventUpgrade,
> = {
  app: { fetch: FetchHandler }
  /**
   * The operator invalidation socket: the events lane's shorthand for one
   * `sockets` entry at `/api/aos/v1/events`.
   */
  events?: ProxySocketService<Upgrade>
  maxEventPeers?: number
  /** Further WebSocket mounts, each with its own path and peer budget. */
  sockets?: readonly ProxySocketMount<Upgrade>[]
  host: string
  port: number
  shutdownGraceMs: number
  close?: () => Promise<void> | void
  serve?: Serve
  installSignalHandlers?: boolean
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
    service: mount.service,
    maxPeers,
    peers: new Set(),
    reserved: 0,
  }
}

export function startProxyServer<
  Upgrade extends SocketUpgrade = OperatorEventUpgrade,
>(options: StartProxyServerOptions<Upgrade>) {
  const mounts = [
    ...(options.events
      ? [
          {
            path: OPERATOR_EVENTS_PATH,
            service: options.events,
            ...(options.maxEventPeers === undefined
              ? {}
              : { maxPeers: options.maxEventPeers }),
          },
        ]
      : []),
    ...(options.sockets ?? []),
  ].map((mount) => mountState(mount))
  const failPeer = (peer: SocketPeer<Upgrade>) => {
    if (peer.data.failed) return
    peer.data.failed = true
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
          open(peer: SocketPeer<Upgrade>) {
            const mount = peer.data.mount
            if (mount.reserved > 0) mount.reserved -= 1
            if (peer.data.overloaded) {
              peer.close(1013, "Event peer capacity exceeded")
              return
            }
            try {
              peer.data.socket = mount.service.open(peer.data.authorization, {
                send: (raw) => peer.send(raw),
                close: (code, reason) => peer.close(code, reason),
              })
              mount.peers.add(peer)
            } catch {
              failPeer(peer)
            }
          },
          message(
            peer: SocketPeer<Upgrade>,
            raw: string | Uint8Array | ArrayBuffer
          ) {
            const frame = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
            void Promise.resolve()
              .then(() => peer.data.socket?.receive(frame))
              .catch(() => failPeer(peer))
          },
          close(peer: SocketPeer<Upgrade>) {
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
    const mount = mounts.find((candidate) => candidate.path === url.pathname)
    if (mount) {
      if (request.method !== "GET") return new Response(null, { status: 405 })
      const authorization = await mount.service.authorizeUpgrade(request)
      if (!authorization) return new Response(null, { status: 401 })
      const upgrade = rawServer as RequestServer | undefined
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
    const response = await options.app.fetch(request, rawServer)
    if (
      response?.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("text/event-stream")
    )
      (rawServer as RequestServer | undefined)?.timeout?.(request, 0)
    return response
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
    shutdownPromise = new Promise<void>((resolve) => {
      let settled = false
      let resourcesClosed = false
      const closeResources = async () => {
        if (resourcesClosed) return
        resourcesClosed = true
        await options.close?.()
      }
      const finish = async () => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        if (onSignal) {
          process.removeListener("SIGINT", onSignal)
          process.removeListener("SIGTERM", onSignal)
        }
        await closeResources().catch(() => undefined)
        resolve()
      }
      const forceTimer = setTimeout(() => {
        void Promise.resolve(server.stop(true)).then(finish, finish)
      }, options.shutdownGraceMs)
      void Promise.resolve(server.stop(false)).then(finish, finish)
    })
    return shutdownPromise
  }

  if (options.installSignalHandlers !== false) {
    onSignal = () => void shutdown()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  }
  return { server, shutdown }
}
