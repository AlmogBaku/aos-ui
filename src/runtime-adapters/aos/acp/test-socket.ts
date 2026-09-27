import type {
  AgentApp,
  AnyWireMessage,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client"
import type { Logger } from "@aos/lifecycle"
import { tabAcpLogger } from "./log"

// Lazy logger for cleanup error reporting; only created if an error fires.
let _socketLog: Logger | undefined
const socketLog = () => (_socketLog ??= tabAcpLogger())

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

/**
 * A browser WebSocket piped to an in-process agent app, with the faults a real
 * network has. The browser connection opens it; the test injects each fault.
 */
export class PipedSocket extends EventTarget {
  readyState = CONNECTING
  readonly #inbound?: WritableStreamDefaultWriter<AnyWireMessage>
  readonly #outbound?: ReadableStreamDefaultReader<AnyWireMessage>
  #halfOpen = false
  #held: string[] | undefined

  /** Without `app` the socket opens but nothing ever answers it. */
  constructor(app: AgentApp | undefined) {
    super()
    if (app) {
      const inbound = new TransformStream<AnyWireMessage, AnyWireMessage>()
      const outbound = new TransformStream<AnyWireMessage, AnyWireMessage>()
      app.connect({ readable: inbound.readable, writable: outbound.writable })
      this.#inbound = inbound.writable.getWriter()
      this.#outbound = outbound.readable.getReader()
      this.#pump(this.#outbound).catch((err: unknown) =>
        socketLog().warn({ err }, "socket.pump_failed")
      )
    }
    queueMicrotask(() => {
      if (this.readyState !== CONNECTING) return
      this.readyState = OPEN
      this.dispatchEvent(new Event("open"))
    })
  }

  async #pump(reader: ReadableStreamDefaultReader<AnyWireMessage>) {
    for (;;) {
      const next = await reader.read().catch(() => undefined)
      // The agent ending its side is the proxy closing the socket.
      if (!next || next.done) {
        this.#end(1000, "", true)
        return
      }
      if (this.readyState !== OPEN || this.#halfOpen) continue
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(next.value) })
      )
    }
  }

  send(data: string) {
    if (this.readyState !== OPEN || this.#halfOpen) return
    if (this.#held) this.#held.push(data)
    else if (this.#inbound)
      this.#inbound
        .write(JSON.parse(data) as AnyWireMessage)
        .catch((err: unknown) =>
          socketLog().warn({ err }, "socket.write_failed")
        )
  }

  close(code = 1000, reason = "") {
    this.#end(code, reason, true)
  }

  /** The network drops: an abnormal close, and the proxy loses its end. */
  drop() {
    this.#end(1006, "", false)
  }

  /** The proxy closes the socket with `code`. */
  closeFromProxy(code: number, reason = "") {
    this.#end(code, reason, true)
  }

  /** Every later frame vanishes both ways, and neither end sees a close. */
  halfOpen() {
    this.#halfOpen = true
  }

  /** Queues the browser's frames until `release`. */
  holdOutbound() {
    this.#held ??= []
  }

  /** Sends the held frames, in order, and stops holding. */
  release() {
    const held = this.#held ?? []
    this.#held = undefined
    for (const data of held) this.send(data)
  }

  #end(code: number, reason: string, wasClean: boolean) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    if (this.#inbound)
      this.#inbound
        .close()
        .catch((err: unknown) =>
          socketLog().warn({ err }, "socket.close_failed")
        )
    if (this.#outbound)
      this.#outbound
        .cancel()
        .catch((err: unknown) =>
          socketLog().warn({ err }, "socket.cancel_failed")
        )
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }))
  }
}

/**
 * The WebSocket constructor a browser connection opens its transports with.
 * Each socket pipes to its own `agentApp()`, so every (re)connection gets its
 * own agent-side connection; `sockets` lists them in the order they opened.
 */
export function pipedSockets(agentApp: () => AgentApp) {
  const sockets: PipedSocket[] = []
  let unanswered = 0
  const nextApp = () => {
    if (unanswered === 0) return agentApp()
    unanswered -= 1
    return undefined
  }
  const WebSocket: WebSocketConstructor = class extends PipedSocket {
    constructor() {
      super(nextApp())
      sockets.push(this)
    }
  }
  return {
    WebSocket,
    sockets,
    /** The next socket opens but reaches no agent, so no handshake is answered. */
    neverAnswerHandshake() {
      unanswered += 1
    },
  }
}
