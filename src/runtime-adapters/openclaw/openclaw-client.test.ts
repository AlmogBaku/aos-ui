import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenClawClient } from "./openclaw-client"
import { MockGateway } from "./mock-gateway"

const clients: OpenClawClient[] = []
function setup() {
  const gateway = new MockGateway()
  const client = new OpenClawClient({
    gatewayUrl: "ws://localhost:18789",
    createSocket: gateway.createSocket,
    deviceAuth: {
      loadIdentity: async () => null,
      tokenStore: { load: () => null, store: () => {}, clear: () => {} },
    },
  })
  clients.push(client)
  return { gateway, client }
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.stop())
})

describe("OpenClaw browser Gateway", () => {
  it("negotiates v4 and preserves native Agent ownership", async () => {
    const { gateway, client } = setup()
    await client.start()
    expect(gateway.requests[0]?.params).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      role: "operator",
    })
    expect(client.getSnapshot().agents.map((agent) => agent.id)).toEqual([
      "alice",
      "bob",
    ])
    expect(client.session("agent:bob:main")?.agentId).toBe("bob")
    expect(client.capabilities.todos).toBe(false)
    expect(client.capabilities.agentVisibilityUpdates).toBe(false)
  })
  it("loads persisted message identities and adopts even an empty active run", async () => {
    const { gateway, client } = setup()
    await client.start()
    gateway.responses.set("chat.history", {
      messages: [
        {
          role: "assistant",
          content: "Saved",
          __openclaw: { id: "durable-row" },
        },
      ],
      inFlightRun: { runId: "recovered", text: "" },
      sessionInfo: { hasActiveRun: true, activeRunIds: ["recovered"] },
    })
    await client.loadHistory("agent:alice:main")
    expect(client.session("agent:alice:main")?.messages[0]).toMatchObject({
      id: "durable-row",
      content: [{ type: "text", text: "Saved" }],
    })
    expect(client.session("agent:alice:main")).toMatchObject({
      running: true,
      runId: "recovered",
    })
  })
  it("deduplicates run sequences and refuses cross-Agent events", async () => {
    const { gateway, client } = setup()
    await client.start()
    await client.loadHistory("agent:alice:main")
    gateway.event("chat", {
      sessionKey: "agent:alice:main",
      agentId: "bob",
      runId: "bad",
      seq: 1,
      state: "delta",
      deltaText: "wrong",
    })
    expect(client.session("agent:alice:main")?.running).toBe(false)
    const event = {
      sessionKey: "agent:alice:main",
      agentId: "alice",
      runId: "run",
      seq: 1,
      state: "delta",
      deltaText: "Hello",
    }
    gateway.event("chat", event)
    gateway.event("chat", event)
    expect(
      client.session("agent:alice:main")?.messages.at(-1)?.content
    ).toEqual([{ type: "text", text: "Hello" }])
    expect(client.session("agent:bob:main")?.running).toBe(false)
  })
  it("binds sends and stop to the exact session and owned run", async () => {
    const { gateway, client } = setup()
    await client.start()
    await client.submit("agent:alice:main", "Hi")
    await client.stopRun("agent:alice:main")
    expect(
      gateway.requests.find((r) => r.method === "chat.send")?.params
    ).toMatchObject({
      agentId: "alice",
      sessionKey: "agent:alice:main",
      message: "Hi",
    })
    expect(
      gateway.requests.find((r) => r.method === "chat.abort")?.params
    ).toEqual({
      agentId: "alice",
      sessionKey: "agent:alice:main",
      runId: "run-1",
    })
  })
  it("rejects oversized attachments before sending a request", async () => {
    const { gateway, client } = setup()
    await client.start()
    await expect(
      client.submit("agent:alice:main", "image", [
        { mimeType: "image/png", content: btoa("x".repeat(51)) },
      ])
    ).rejects.toThrow(/attachment/i)
    expect(
      gateway.requests.filter((r) => r.method === "chat.send")
    ).toHaveLength(0)
  })
  it("discovers questions and submits answers by stable question ID", async () => {
    const { gateway, client } = setup()
    gateway.responses.set("question.list", {
      questions: [
        {
          id: "question-1",
          agentId: "alice",
          sessionKey: "agent:alice:main",
          createdAtMs: 1000,
          expiresAtMs: 9999999999999,
          status: "pending",
          questions: [
            {
              questionId: "color",
              header: "Color",
              question: "Which color?",
              options: [{ label: "Blue" }],
            },
          ],
        },
      ],
    })
    await client.start()
    expect(
      client.pendingQuestions("agent:alice:main")[0]?.questions[0]?.id
    ).toBe("color")
    await client.answerQuestion("agent:alice:main", "question-1", [["Blue"]])
    expect(gateway.requests.at(-1)?.params).toEqual({
      id: "question-1",
      answers: { answers: { color: ["Blue"] } },
    })
  })
  it("surfaces pairing errors and does not silently become ready", async () => {
    const { gateway, client } = setup()
    gateway.connectError = {
      code: "NOT_PAIRED",
      message: "Pairing required",
      details: {
        code: "PAIRING_REQUIRED",
        requestId: "pair-123",
        recommendedNextStep: "approve-device",
      },
    }
    await expect(client.start()).rejects.toThrow("Pairing required")
    expect(client.getSnapshot().connection).toBe("blocked")
    expect(client.getSnapshot().connectionDetails).toMatchObject({
      requestId: "pair-123",
    })
  })
  it("backfills approval requests and enforces Session-bound decisions", async () => {
    const { gateway, client } = setup()
    gateway.responses.set("exec.approval.list", [
      {
        id: "approval-1",
        request: {
          sessionKey: "agent:alice:main",
          agentId: "alice",
          command: "ls",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1000,
        expiresAtMs: 9999999999999,
      },
    ])
    await client.start()
    expect(client.pendingApprovals("agent:alice:main")).toHaveLength(1)
    await expect(
      client.answerApproval("agent:bob:main", "approval-1", "allow-once")
    ).rejects.toThrow(/unavailable/)
    await expect(
      client.answerApproval("agent:alice:main", "approval-1", "allow-always")
    ).rejects.toThrow(/decision/)
    await client.answerApproval("agent:alice:main", "approval-1", "allow-once")
    expect(gateway.requests.at(-1)?.params).toEqual({
      id: "approval-1",
      decision: "allow-once",
    })
    expect(client.pendingApprovals("agent:alice:main")).toHaveLength(0)
  })
  it("reconnects subscriptions and replaces stale running history", async () => {
    const { gateway, client } = setup()
    await client.start()
    await client.loadHistory("agent:alice:main")
    await client.submit("agent:alice:main", "Hi")
    gateway.handlers?.close(1006, "network lost")
    await vi.waitFor(
      () => expect(client.getSnapshot().connection).toBe("ready"),
      { timeout: 3000 }
    )
    expect(client.session("agent:alice:main")).toMatchObject({
      running: false,
      runId: undefined,
    })
    expect(
      gateway.requests.filter((r) => r.method === "sessions.messages.subscribe")
        .length
    ).toBeGreaterThan(1)
  })
  it("refetches authoritative history on a per-run sequence gap", async () => {
    const { gateway, client } = setup()
    await client.start()
    await client.loadHistory("agent:alice:main")
    gateway.event("chat", {
      sessionKey: "agent:alice:main",
      runId: "run",
      seq: 1,
      state: "delta",
      deltaText: "Partial",
    })
    gateway.responses.set("chat.history", {
      messages: [
        {
          role: "assistant",
          content: "Recovered",
          __openclaw: { id: "durable" },
        },
      ],
      sessionInfo: { activeRunIds: [] },
    })
    gateway.event("chat", {
      sessionKey: "agent:alice:main",
      runId: "run",
      seq: 3,
      state: "delta",
      deltaText: "missing middle",
    })
    await vi.waitFor(() =>
      expect(client.session("agent:alice:main")?.messages[0]?.content).toEqual([
        { type: "text", text: "Recovered" },
      ])
    )
  })
  it("preserves native tool calls and associates persisted tool results", async () => {
    const { gateway, client } = setup()
    await client.start()
    gateway.responses.set("chat.history", {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "aos_present_stats",
              arguments: { value: 2 },
            },
          ],
          __openclaw: { id: "assistant-1" },
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "text", text: '{"value":2}' }],
          details: { value: 2 },
        },
      ],
      sessionInfo: { activeRunIds: [] },
    })
    await client.loadHistory("agent:alice:main")
    expect(client.session("agent:alice:main")?.messages[0]?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "aos_present_stats",
        args: { value: 2 },
        argsText: '{"value":2}',
        result: { value: 2 },
        isError: false,
      },
    ])
  })
  it("projects the accepted user prompt without reactivating a run that already finished", async () => {
    const { gateway, client } = setup()
    await client.start()
    const send = client.submit("agent:alice:main", "My prompt")
    gateway.event("chat", {
      sessionKey: "agent:alice:main",
      runId: "run-1",
      seq: 1,
      state: "final",
      message: { role: "assistant", content: "Done" },
    })
    await send
    expect(client.session("agent:alice:main")?.running).toBe(false)
    expect(
      client.session("agent:alice:main")?.messages.map((m) => m.role)
    ).toEqual(["user", "assistant"])
  })
  it("lists models and uses native model IDs when changing a Session", async () => {
    const { gateway, client } = setup()
    gateway.responses.set("models.list", {
      models: [{ id: "model-a", provider: "provider-a", name: "Model A" }],
    })
    gateway.responses.set("sessions.patch", { ok: true })
    await client.start()
    expect(await client.listModels()).toEqual([
      { id: "provider-a/model-a", label: "Model A", group: "provider-a" },
    ])
    await client.selectModel("agent:alice:main", "provider-a/model-a")
    expect(
      gateway.requests.find((request) => request.method === "sessions.patch")
        ?.params
    ).toEqual({
      key: "agent:alice:main",
      agentId: "alice",
      model: "provider-a/model-a",
    })
  })
  it("decodes native speech bytes and aborts stale playback requests", async () => {
    const { gateway, client } = setup()
    gateway.responses.set("talk.speak", {
      audioBase64: btoa("audio"),
      provider: "speech",
      mimeType: "audio/mpeg",
    })
    await client.start()
    expect(
      (await client.synthesize("Hello", new AbortController().signal)).size
    ).toBe(5)
    await expect(client.synthesize("Hi", AbortSignal.abort())).rejects.toThrow()
  })
  it("routes native tool events by an exact known run and keeps tool results inspectable", async () => {
    const { gateway, client } = setup()
    await client.start()
    await client.submit("agent:alice:main", "Run tool")
    gateway.event("agent", {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: 1000,
      data: {
        phase: "start",
        toolCallId: "tool-1",
        name: "read",
        args: { path: "README.md" },
      },
    })
    gateway.event("agent", {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      ts: 1001,
      data: {
        phase: "result",
        toolCallId: "tool-1",
        name: "read",
        result: { text: "Contents" },
      },
    })
    expect(
      client.session("agent:alice:main")?.messages.at(-1)?.content
    ).toMatchObject([
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "read",
        result: { text: "Contents" },
      },
    ])
    expect(client.session("agent:bob:main")?.messages).toEqual([])
  })
  it("does not resurrect completed runs when a later nonterminal frame arrives", async () => {
    const { gateway, client } = setup()
    await client.start()
    gateway.event("chat", {
      sessionKey: "agent:alice:main",
      runId: "run",
      seq: 1,
      state: "final",
      message: { role: "assistant", content: "Done" },
    })
    gateway.event("chat", {
      sessionKey: "agent:alice:main",
      runId: "run",
      seq: 2,
      state: "delta",
      deltaText: "late",
    })
    expect(client.session("agent:alice:main")?.running).toBe(false)
  })
  it("marks native attention as waiting and publishes an Agent-scoped activity event", async () => {
    const { gateway, client } = setup()
    await client.start()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    gateway.event("question.requested", {
      id: "q",
      sessionKey: "agent:alice:main",
      agentId: "alice",
      status: "pending",
      expiresAtMs: 9999999999999,
      questions: [
        {
          questionId: "pick",
          header: "Pick",
          question: "Pick one",
          options: [],
        },
      ],
    })
    expect(client.session("agent:alice:main")?.status).toBe("waiting-for-input")
    expect(events).toMatchObject([
      {
        type: "attention-requested",
        agentId: "alice",
        threadId: "agent:alice:main",
        requestId: "q",
        attentionKind: "question",
      },
    ])
    gateway.event("question.resolved", { id: "q", status: "cancelled" })
    expect(events.at(-1)).toMatchObject({
      type: "attention-resolved",
      requestId: "q",
    })
  })
  it("loads every roster page using native nextOffset and deduplicates owner-first rows", async () => {
    const { gateway, client } = setup()
    gateway.responders.set("sessions.list", (params) =>
      params.offset === 10
        ? {
            sessions: [
              { key: "agent:bob:main", agentId: "bob", activeRunIds: [] },
              { key: "agent:alice:main", agentId: "alice", activeRunIds: [] },
            ],
            hasMore: false,
          }
        : {
            sessions: [
              { key: "agent:alice:main", agentId: "alice", activeRunIds: [] },
            ],
            hasMore: true,
            nextOffset: 10,
          }
    )
    await client.start()
    expect(
      client.getSnapshot().sessions.map((session) => session.threadId)
    ).toEqual(["agent:alice:main", "agent:bob:main"])
    expect(
      gateway.requests.find((request) => request.method === "sessions.list")
        ?.params.offset
    ).toBe(10)
  })
})
