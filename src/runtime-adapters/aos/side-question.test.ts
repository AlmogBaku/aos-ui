import {
  agent,
  methods,
  type AgentContext,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { createAcpConnection } from "@harness-gw/sdk"
import {
  HGW_EXTENSION_VERSION,
  HGW_META_KEY,
  HGW_METHODS,
} from "@harness-gw/sdk/protocol"
import { describe, expect, it, onTestFinished } from "vitest"
import { z } from "zod"

import { useFakeClock } from "../../../test/support/fake-clock"
import { pipedSockets } from "./acp/test-socket"
import { createSideQuestions } from "./side-question"

const PARENT = "session-pricing-review"
const FORK = "session-pricing-review-fork"
const QUESTION = "Which competitor did it start with?"
const ANSWER =
  "Contoso: its pricing page changed last week, and it's the one the board asked about."
const SETTLE_MS = 5_000

const turn = (sequence: number) => ({
  _meta: { [HGW_META_KEY]: { turnId: "turn-1", sequence } },
})

/**
 * The operator gateway, in process, for one Session that forks. The fork's
 * turn moves only when the test moves it, as a provider's would.
 */
function forkingGateway({ holdArchive = false } = {}) {
  let peer: AgentContext | undefined
  let releaseArchive = () => {}
  const push = (update: SessionUpdate) =>
    void peer?.notify(methods.client.session.update, {
      sessionId: FORK,
      update,
    })
  const app = agent({ name: "fake-gateway" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 2,
      info: { name: "harness-gw", version: "1" },
      capabilities: { session: { fork: {} } },
      _meta: {
        [HGW_META_KEY]: {
          version: HGW_EXTENSION_VERSION,
          role: "operator",
          extensions: {
            steer: true,
            rewind: true,
            composerPrefill: true,
            agents: true,
            invalidation: true,
            activity: true,
            readState: true,
            focus: true,
            guestProjection: false,
          },
        },
      },
    }))
    .onRequest(methods.agent.session.fork, () => ({ sessionId: FORK }))
    .onRequest(HGW_METHODS.session.update, z.unknown(), async ({ params }) => {
      const archiving =
        typeof params === "object" && params !== null && "archived" in params
      if (holdArchive && archiving)
        await new Promise<void>((resolve) => (releaseArchive = resolve))
      return {}
    })
    .onRequest(methods.agent.session.prompt, () => {
      queueMicrotask(() => {
        push({ sessionUpdate: "state_update", state: "running", ...turn(0) })
        push({
          sessionUpdate: "user_message",
          messageId: "question",
          content: [{ type: "text", text: QUESTION }],
          ...turn(1),
        })
      })
      return { messageId: "question" }
    })
    .onNotification(methods.agent.session.cancel, () => undefined)
    .onRequest(methods.agent.session.delete, () => ({}))
    .onRequest(HGW_METHODS.session.part, z.unknown(), () => ({}))
    .onConnect((connection) => {
      peer = connection.client
    })
  return {
    app,
    releaseArchive: () => releaseArchive(),
    reply(messageId: string, text: string, sequence: number) {
      push({
        sessionUpdate: "agent_message",
        messageId,
        content: [{ type: "text", text }],
        ...turn(sequence),
      })
    },
    end() {
      push({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        ...turn(9),
      })
    },
    /** A permission request, as the gateway sends one: the state, then the ask. */
    askPermission() {
      push({
        sessionUpdate: "state_update",
        state: "requires_action",
        ...turn(2),
      })
      void peer
        ?.request(methods.client.session.requestPermission, {
          sessionId: FORK,
          title: "Send the pricing summary to the board",
          subject: {
            type: "tool_call",
            toolCall: { toolCallId: "send-email", status: "pending" },
          },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
          ],
          _meta: { [HGW_META_KEY]: { requestId: "permission-1" } },
        })
        .catch(() => {})
    },
  }
}

/** Asks one side question about `PARENT` over a real browser connection. */
function ask(gateway: ReturnType<typeof forkingGateway>) {
  const { WebSocket, sockets } = pipedSockets(() => gateway.app)
  const connection = createAcpConnection({
    url: "ws://gateway.test/api/v1/acp",
    clientInfo: { name: "aos-ui", version: "1" },
    socketConstructor: WebSocket,
  })
  connection.start()
  onTestFinished(() => connection.close())
  const question = createSideQuestions({
    connection,
    // What the workspace client sends for a read.
    markSessionRead: (sessionId) =>
      connection.updateSession({ sessionId, unread: false }),
    settleTimeoutMs: SETTLE_MS,
  })(PARENT, QUESTION)
  /** What reached the gateway, in wire order, past the handshake. */
  const wire = () =>
    (sockets[0]?.sent ?? []).flatMap((frame) => {
      if (!("method" in frame) || frame.method === methods.agent.initialize)
        return []
      const { sessionId, ...rest } = frame.params as { sessionId?: string }
      return frame.method === HGW_METHODS.session.update
        ? [`${sessionId} ${JSON.stringify(rest)}`]
        : [`${sessionId} ${frame.method}`]
    })
  return { question, wire }
}

const FORKED = `${PARENT} ${methods.agent.session.fork}`
const ARCHIVED = `${FORK} {"archived":true}`
const PROMPTED = `${FORK} ${methods.agent.session.prompt}`

describe("side questions", () => {
  it("keeps watching its fork while a slow archive outlasts the part grace, then asks", async () => {
    const clock = useFakeClock()
    const gateway = forkingGateway({ holdArchive: true })
    const { wire } = ask(gateway)

    await clock.advance(2_500)
    // Nothing parts the fork, and nothing is asked before it is hidden.
    expect(wire()).toEqual([FORKED, ARCHIVED])

    gateway.releaseArchive()
    await clock.advance(0)
    expect(wire()).toEqual([FORKED, ARCHIVED, PROMPTED])
  })

  it("answers with the fork's last reply and marks the fork read once its turn ends", async () => {
    const clock = useFakeClock()
    const gateway = forkingGateway()
    const { question, wire } = ask(gateway)
    await clock.advance(0)

    gateway.reply("reply-1", "Checking the pricing notes.", 2)
    gateway.reply("reply-2", ANSWER, 3)
    await clock.advance(0)
    expect(question.snapshot()).toEqual({
      state: "asking",
      answer: ANSWER,
      sessionId: FORK,
    })
    expect(wire()).toEqual([FORKED, ARCHIVED, PROMPTED])

    gateway.end()
    await clock.advance(0)
    expect(question.snapshot()).toEqual({
      state: "answered",
      answer: ANSWER,
      sessionId: FORK,
    })
    expect(wire()).toEqual([
      FORKED,
      ARCHIVED,
      PROMPTED,
      `${FORK} {"unread":false}`,
    ])
  })

  it("needs input while a permission waits in the fork", async () => {
    const clock = useFakeClock()
    const gateway = forkingGateway()
    const { question } = ask(gateway)
    await clock.advance(0)

    gateway.askPermission()
    await clock.advance(0)

    expect(question.snapshot().state).toBe("needs-input")
  })

  it.each<[string, (gateway: ReturnType<typeof forkingGateway>) => void]>([
    ["its turn ends", (gateway) => gateway.end()],
    ["the wait runs out", () => undefined],
  ])(
    "Dismiss while asking stops the turn, and deletes the fork once %s",
    async (_, settle) => {
      const clock = useFakeClock()
      const gateway = forkingGateway()
      const { question, wire } = ask(gateway)
      await clock.advance(0)

      const dismissed = question.dismiss()
      await clock.advance(SETTLE_MS - 1)
      expect(wire()).toEqual([
        FORKED,
        ARCHIVED,
        PROMPTED,
        `${FORK} ${methods.agent.session.cancel}`,
      ])

      settle(gateway)
      await clock.advance(1)
      await dismissed
      expect(wire()).toEqual([
        FORKED,
        ARCHIVED,
        PROMPTED,
        `${FORK} ${methods.agent.session.cancel}`,
        `${FORK} ${methods.agent.session.delete}`,
      ])
    }
  )

  it("keeps the fork on Continue: unarchived, and no later Dismiss deletes it", async () => {
    const clock = useFakeClock()
    const gateway = forkingGateway()
    const { question, wire } = ask(gateway)
    await clock.advance(0)
    gateway.reply("reply-1", ANSWER, 2)
    gateway.end()
    await clock.advance(0)

    await expect(question.keep()).resolves.toEqual({ sessionId: FORK })
    await question.dismiss()
    await clock.advance(0)

    expect(wire()).toEqual([
      FORKED,
      ARCHIVED,
      PROMPTED,
      `${FORK} {"unread":false}`,
      `${FORK} {"archived":false}`,
    ])
  })
})
