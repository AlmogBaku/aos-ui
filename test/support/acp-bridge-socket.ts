import type { WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client"

import type { AcpPeer, AcpUpgrade } from "../../packages/proxy/acp/service"
import type { SocketRefusal } from "../../packages/proxy/server"

/** The calls a network listener makes on one ACP service. */
export type BridgedAcpService = {
  authorizeUpgrade(
    request: Request
  ): Promise<AcpUpgrade | SocketRefusal | undefined>
  open(
    upgrade: AcpUpgrade,
    peer: AcpPeer
  ): { receive(raw: string | Uint8Array): unknown; close(): void }
}

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3
/** The code a browser reports for a socket whose upgrade was refused. */
const ABNORMAL_CLOSE = 1006

/** The headers every WebSocket upgrade carries, beside the caller's own. */
const UPGRADE_HEADERS = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
}

/**
 * An in-memory WebSocket for the SDK's `createWebSocketStream` that reaches
 * `service` the way the network listener does: each socket's upgrade goes to
 * `authorizeUpgrade`, then `open`, and each frame it sends to `receive`. It
 * runs on microtasks alone, so a fake clock drives only the service's timers.
 *
 * A socket's `send` writes a raw text frame, and its `frames` hold every raw
 * frame the server sent it.
 */
export function acpBridge(service: BridgedAcpService) {
  const sockets: BridgeSocket[] = []
  /** Every upgrade request the service refused. */
  const refusals: Request[] = []

  class BridgeSocket extends EventTarget {
    static readonly CONNECTING = CONNECTING
    static readonly OPEN = OPEN
    static readonly CLOSING = CLOSING
    static readonly CLOSED = CLOSED
    readyState = CONNECTING
    readonly frames: string[] = []
    #connection: ReturnType<BridgedAcpService["open"]> | undefined

    constructor(
      url: string,
      _protocols?: string | string[],
      options?: { headers?: Record<string, string> }
    ) {
      super()
      sockets.push(this)
      const request = new Request(url.replace(/^ws/u, "http"), {
        headers: { ...UPGRADE_HEADERS, ...options?.headers },
      })
      queueMicrotask(() => void this.#upgrade(request))
    }

    async #upgrade(request: Request) {
      const upgrade = await service.authorizeUpgrade(request)
      if (!upgrade || "refused" in upgrade) {
        refusals.push(request)
        this.readyState = CLOSED
        this.dispatchEvent(new Event("error"))
        this.dispatchEvent(new CloseEvent("close", { code: ABNORMAL_CLOSE }))
        return
      }
      this.#connection = service.open(upgrade, {
        send: (raw) => {
          // A frame already written reaches the client before any close.
          this.frames.push(raw)
          queueMicrotask(() =>
            this.dispatchEvent(new MessageEvent("message", { data: raw }))
          )
          return Buffer.byteLength(raw)
        },
        isOpen: () => this.readyState === OPEN,
        close: (code, reason) => this.#closed(code, reason),
      })
      // A service that closed its peer while opening it is released here, as
      // the listener does.
      if (this.readyState !== CONNECTING) return this.#connection.close()
      this.readyState = OPEN
      this.dispatchEvent(new Event("open"))
    }

    /** Ends the socket as the listener's close handler does, once. */
    #closed(code: number, reason: string) {
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      this.#connection?.close()
      queueMicrotask(() =>
        this.dispatchEvent(new CloseEvent("close", { code, reason }))
      )
    }

    send(data: string) {
      if (this.readyState !== OPEN) throw new Error("The socket is not open")
      void this.#connection!.receive(data)
    }

    close(code = 1000, reason = "") {
      this.#closed(code, reason)
    }
  }

  return {
    WebSocket: BridgeSocket as WebSocketConstructor,
    sockets: (): readonly BridgeSocket[] => sockets,
    refusals: (): readonly Request[] => refusals,
  }
}
