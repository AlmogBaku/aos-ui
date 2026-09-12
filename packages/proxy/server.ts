import type {
  OperatorEventService,
  OperatorEventUpgrade,
} from "./events/service"
import type { EventsSocket } from "./events/socket"

type FetchHandler = (
  request: Request,
  server?: unknown
) => Response | undefined | Promise<Response | undefined>
type Server = { stop(closeActiveConnections?: boolean): Promise<void> | void }
type EventSocketData = {
  authorization: OperatorEventUpgrade
  socket?: EventsSocket
  failed?: boolean
}
type EventPeer = {
  data: EventSocketData
  send(raw: string): void
  close(code?: number, reason?: string): void
}
type UpgradeServer = {
  upgrade(request: Request, options: { data: EventSocketData }): boolean
}
type ServeOptions = {
  hostname: string
  port: number
  fetch: FetchHandler
  websocket?: {
    open(peer: EventPeer): void
    message(peer: EventPeer, raw: string | Uint8Array | ArrayBuffer): void
    close(peer: EventPeer): void
  }
}
type Serve = (options: ServeOptions) => Server

export type StartProxyServerOptions = {
  app: { fetch: FetchHandler }
  events?: OperatorEventService
  host: string
  port: number
  shutdownGraceMs: number
  serve?: Serve
  installSignalHandlers?: boolean
}

function bunServe(): Serve {
  const bun = (globalThis as unknown as { Bun?: { serve: Serve } }).Bun
  if (!bun) throw new Error("Bun runtime is required")
  return bun.serve.bind(bun)
}

export function startProxyServer(options: StartProxyServerOptions) {
  const activeEventPeers = new Set<EventPeer>()
  const failEventPeer = (peer: EventPeer) => {
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
        open(peer: EventPeer) {
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
        message(peer: EventPeer, raw: string | Uint8Array | ArrayBuffer) {
          const frame = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
          void Promise.resolve()
            .then(() => peer.data.socket?.receive(frame))
            .catch(() => failEventPeer(peer))
        },
        close(peer: EventPeer) {
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
      url.pathname === "/api/aos/v1/events" &&
      url.search === ""
    ) {
      if (request.method !== "GET") return new Response(null, { status: 405 })
      const authorization = await options.events.authorizeUpgrade(request)
      if (!authorization) return new Response(null, { status: 401 })
      const upgrade = rawServer as UpgradeServer | undefined
      if (!upgrade?.upgrade(request, { data: { authorization } }))
        return new Response(null, { status: 500 })
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
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
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
    const onSignal = () => void shutdown()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  }
  return { server, shutdown }
}
