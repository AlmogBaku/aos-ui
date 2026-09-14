import type { OperatorEventUpgrade } from "./events/service"
import type { EventsSocket } from "./events/socket"

type FetchHandler = (
  request: Request,
  server?: unknown
) => Response | undefined | Promise<Response | undefined>
type Server = { stop(closeActiveConnections?: boolean): Promise<void> | void }
type EventSocketData<Authorization> = {
  authorization: Authorization
  socket?: EventsSocket
  failed?: boolean
  overloaded?: boolean
}
type EventPeer<Authorization> = {
  data: EventSocketData<Authorization>
  send(raw: string): void
  close(code?: number, reason?: string): void
}
type UpgradeServer = {
  upgrade<Authorization>(
    request: Request,
    options: { data: EventSocketData<Authorization> }
  ): boolean
}
type RequestServer = UpgradeServer & {
  timeout?(request: Request, seconds: number): void
}
type ServeOptions<Authorization> = {
  hostname: string
  port: number
  fetch: FetchHandler
  websocket?: {
    open(peer: EventPeer<Authorization>): void
    message(
      peer: EventPeer<Authorization>,
      raw: string | Uint8Array | ArrayBuffer
    ): void
    close(peer: EventPeer<Authorization>): void
  }
}
type Serve = <Authorization>(options: ServeOptions<Authorization>) => Server

type EventService<Authorization> = {
  authorizeUpgrade(request: Request): Promise<Authorization | undefined>
  open(
    authorization: Authorization,
    peer: { send(raw: string): void; close(code: number, reason: string): void }
  ): EventsSocket
}

export type StartProxyServerOptions<Authorization = OperatorEventUpgrade> = {
  app: { fetch: FetchHandler }
  events?: EventService<Authorization>
  eventsPath?: string
  host: string
  port: number
  shutdownGraceMs: number
  maxEventPeers?: number
  close?: () => Promise<void> | void
  serve?: Serve
  installSignalHandlers?: boolean
}

function bunServe(): Serve {
  const bun = (globalThis as unknown as { Bun?: { serve: Serve } }).Bun
  if (!bun) throw new Error("Bun runtime is required")
  return bun.serve.bind(bun)
}

export function startProxyServer<Authorization = OperatorEventUpgrade>(
  options: StartProxyServerOptions<Authorization>
) {
  const activeEventPeers = new Set<EventPeer<Authorization>>()
  const maxEventPeers = options.maxEventPeers ?? Number.MAX_SAFE_INTEGER
  let reservedEventPeers = 0
  if (!Number.isSafeInteger(maxEventPeers) || maxEventPeers < 1)
    throw new Error("Invalid event peer limit")
  const failEventPeer = (peer: EventPeer<Authorization>) => {
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
  const websocket = options.events
    ? {
        open(peer: EventPeer<Authorization>) {
          if (reservedEventPeers > 0) reservedEventPeers -= 1
          if (peer.data.overloaded) {
            peer.close(1013, "Event peer capacity exceeded")
            return
          }
          try {
            peer.data.socket = options.events!.open(peer.data.authorization, {
              send: (raw) => peer.send(raw),
              close: (code, reason) => peer.close(code, reason),
            })
            activeEventPeers.add(peer)
          } catch {
            failEventPeer(peer)
          }
        },
        message(
          peer: EventPeer<Authorization>,
          raw: string | Uint8Array | ArrayBuffer
        ) {
          const frame = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
          void Promise.resolve()
            .then(() => peer.data.socket?.receive(frame))
            .catch(() => failEventPeer(peer))
        },
        close(peer: EventPeer<Authorization>) {
          activeEventPeers.delete(peer)
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
    if (
      options.events &&
      url.pathname === (options.eventsPath ?? "/api/aos/v1/events")
    ) {
      if (request.method !== "GET") return new Response(null, { status: 405 })
      const authorization = await options.events.authorizeUpgrade(request)
      if (!authorization) return new Response(null, { status: 401 })
      const upgrade = rawServer as RequestServer | undefined
      const overloaded =
        activeEventPeers.size + reservedEventPeers >= maxEventPeers
      if (!overloaded) reservedEventPeers += 1
      if (!upgrade?.upgrade(request, { data: { authorization, overloaded } })) {
        if (!overloaded) reservedEventPeers -= 1
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
    for (const peer of activeEventPeers) {
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
    activeEventPeers.clear()
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
