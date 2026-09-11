import type { GatewayProtocolSocketHandlers } from "@openclaw/gateway-client/browser"
import {
  validateConnectParams,
  validateChatSendParams,
} from "@openclaw/gateway-protocol"

/** Deterministic wire-level Gateway used only by adapter tests. */
export class MockGateway {
  responders = new Map<string, (params: Record<string, unknown>) => unknown>()
  private response(method: string, params: Record<string, unknown>) {
    return (
      this.responders.get(method)?.(params) ??
      this.responses.get(method) ?? { ok: true }
    )
  }
  handlers?: GatewayProtocolSocketHandlers
  requests: { method: string; params: Record<string, unknown> }[] = []
  responses = new Map<string, unknown>([
    [
      "agents.list",
      {
        defaultId: "alice",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "alice", name: "Alice" }, { id: "bob" }],
      },
    ],
    [
      "sessions.list",
      {
        sessions: [
          {
            key: "agent:alice:main",
            agentId: "alice",
            label: "Alice session",
            updatedAt: 1000,
            activeRunIds: [],
            hasActiveRun: false,
          },
          {
            key: "agent:bob:main",
            agentId: "bob",
            updatedAt: 1000,
            activeRunIds: [],
          },
        ],
      },
    ],
    [
      "chat.history",
      {
        sessionId: "native-1",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
            __openclaw: { id: "message-1" },
          },
        ],
        sessionInfo: { hasActiveRun: false, activeRunIds: [] },
      },
    ],
    ["chat.send", { runId: "run-1", status: "started" }],
    ["chat.abort", { ok: true }],
    ["question.list", { questions: [] }],
    ["exec.approval.list", []],
    [
      "sessions.create",
      { ok: true, key: "agent:alice:new", sessionId: "native-new" },
    ],
  ])
  connectError?: { code: string; message: string; details: unknown }
  createSocket = (handlers: GatewayProtocolSocketHandlers) => {
    this.handlers = handlers
    let open = true
    queueMicrotask(() => {
      handlers.open()
      this.event("connect.challenge", { nonce: "challenge", ts: 1000 })
    })
    return {
      isOpen: () => open,
      close: (code = 1000, reason = "") => {
        open = false
        handlers.close(code, reason)
      },
      send: (data: string) => {
        const frame = JSON.parse(data)
        this.requests.push(frame)
        if (frame.method === "connect" && !validateConnectParams(frame.params))
          throw new Error("Invalid connect frame")
        if (
          frame.method === "chat.send" &&
          !validateChatSendParams(frame.params)
        )
          throw new Error("Invalid chat.send frame")
        queueMicrotask(() =>
          handlers.message(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: !(frame.method === "connect" && this.connectError),
              ...(frame.method === "connect" && this.connectError
                ? { error: this.connectError }
                : {
                    payload:
                      frame.method === "connect"
                        ? {
                            type: "hello-ok",
                            protocol: 4,
                            server: { version: "2026.8.1", connId: "mock" },
                            features: {
                              methods: [
                                ...this.responses.keys(),
                                "sessions.subscribe",
                                "sessions.messages.subscribe",
                                "question.resolve",
                                "exec.approval.resolve",
                              ],
                              events: ["chat", "agent", "question.requested"],
                            },
                            snapshot: {
                              presence: [],
                              health: {},
                              stateVersion: { presence: 0, health: 0 },
                              uptimeMs: 1,
                            },
                            auth: {
                              role: "operator",
                              scopes: [
                                "operator.read",
                                "operator.write",
                                "operator.questions",
                                "operator.approvals",
                              ],
                            },
                            policy: {
                              maxPayload: 1000000,
                              maxBufferedBytes: 1000000,
                              tickIntervalMs: 30000,
                              attachments: { maxBytes: 100, maxImageBytes: 50 },
                            },
                          }
                        : frame.method === "sessions.subscribe"
                          ? {
                              subscribed: true,
                              list: this.response(
                                "sessions.list",
                                frame.params
                              ),
                            }
                          : this.response(frame.method, frame.params),
                  }),
            })
          )
        )
      },
    }
  }
  event(event: string, payload: unknown) {
    this.handlers?.message(JSON.stringify({ type: "event", event, payload }))
  }
}
