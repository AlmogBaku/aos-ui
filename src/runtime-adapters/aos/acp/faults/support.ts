/**
 * The browser fault rows' shared setup: a browser connection to the harness
 * proxy over piped sockets, the frames it sends, and the transcript it holds.
 * Only a test file may import the proxy, so each row hands its harness in.
 */
import { onTestFinished, vi } from "vitest"

import { createAcpConnection } from "../connection"
import {
  applyUpdate,
  clearTranscript,
  initialProjectorState,
  replacedTurns,
} from "../session-projector"
import type { AcpConnection } from "../types"
import { PipedSocket, pipedSockets } from "../test-socket"

/** What a browser connection needs of the harness proxy. */
type Harness = { agentApp: Parameters<typeof pipedSockets>[0]; close(): void }

/**
 * A browser connection to the harness proxy over piped sockets, not started.
 * The test fakes the clock first, so every deadline runs on it.
 */
export function connectBrowser<T extends Harness>(test: T) {
  const pipe = pipedSockets(test.agentApp)
  const connection = createAcpConnection({
    clientInfo: { name: "aos-ui", version: "1" },
    url: "ws://proxy.test/api/aos/v1/acp",
    socketConstructor: pipe.WebSocket,
  })
  onTestFinished(() => {
    connection.close()
    test.close()
  })
  return { test, pipe, connection }
}

export type Frame = {
  method?: string
  params?: {
    sessionId?: string
    replayFrom?: { type: string }
    _meta?: { aos?: { clientId?: string } }
  }
}

/**
 * Every frame the browser sends, in order. `fault` sees each as it leaves and
 * may fault its socket instead, so the proxy never receives that frame.
 */
export function sentFrames(
  fault?: (frame: Frame, socket: PipedSocket) => boolean
) {
  const frames: Frame[] = []
  const send = PipedSocket.prototype.send
  vi.spyOn(PipedSocket.prototype, "send").mockImplementation(function (
    this: PipedSocket,
    data: string
  ) {
    const frame = JSON.parse(data) as Frame
    frames.push(frame)
    if (!fault?.(frame, this)) send.call(this, data)
  })
  return frames
}

export const methodsOf = (frames: Frame[], session: string) =>
  frames.flatMap((frame) =>
    frame.params?.sessionId === session && frame.method ? [frame.method] : []
  )

/**
 * Subscribes to a Session as the thread does, folding its updates with the
 * session projector and letting a from-start replay replace what it resends
 * once it lands. Reads the transcript as `role: text`, one line per message.
 */
export function watchTranscript(
  connection: AcpConnection,
  { agentId, sessionId }: { agentId: string; sessionId: string }
) {
  let state = initialProjectorState
  let replacing: ReadonlySet<string> | undefined
  connection.subscribe(sessionId, {
    agentId,
    update: (update, meta) => {
      const base = replacing ? clearTranscript(state, replacing) : state
      replacing = undefined
      state = applyUpdate(base, update, meta)
    },
    replay: () => {
      const replaced = replacedTurns(state)
      replacing = replaced
      return (replayed) => {
        if (replacing !== replaced) return
        replacing = undefined
        if (replayed) state = clearTranscript(state, replaced)
      }
    },
  })
  return () =>
    state.messages.map(({ role, parts }) => {
      const text = parts.flatMap((part) =>
        "block" in part && part.block.type === "text" ? [part.block.text] : []
      )
      return `${role}: ${text.join("")}`
    })
}
