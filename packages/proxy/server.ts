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

export function startProxyServer<Upgrade extends SocketUpgrade = SocketUpgrade>(
  options: StartProxyServerOptions<Upgrade>
) {
  const mounts = (options.sockets ?? []).map((mount) => mountState(mount))
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
      void Promise.resolve()
        .then(() => server.stop(false))
        .catch(() => undefined)
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
    onSignal = () => void shutdown()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  }
  return { server, shutdown }
}
