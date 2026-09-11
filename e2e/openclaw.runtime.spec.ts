import { expect, test } from "@playwright/test"

test("OpenClaw uses the same-origin Gateway and projects native history", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> =
      []
    ;(
      window as unknown as { __openclawRequests: typeof requests }
    ).__openclawRequests = requests
    ;(
      window as unknown as { __openclawSocketUrls: string[] }
    ).__openclawSocketUrls = []

    class NativeSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly url: string
      readyState = NativeSocket.CONNECTING
      constructor(url: string | URL) {
        super()
        this.url = String(url)
        ;(
          window as unknown as { __openclawSocketUrls: string[] }
        ).__openclawSocketUrls.push(this.url)
        queueMicrotask(() => {
          this.readyState = NativeSocket.OPEN
          this.dispatchEvent(new Event("open"))
          this.message({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "e2e-challenge", ts: Date.now() },
          })
        })
      }
      send(raw: string) {
        const frame = JSON.parse(raw) as {
          id: string
          method: string
          params: Record<string, unknown>
        }
        requests.push({ method: frame.method, params: frame.params })
        const historyText = "Native OpenClaw history"
        const responses: Record<string, unknown> = {
          "agents.list": { agents: [{ id: "research", name: "Research" }] },
          "sessions.subscribe": {
            subscribed: true,
            list: {
              sessions: [
                {
                  key: "agent:research:main",
                  agentId: "research",
                  label: "OpenClaw Session",
                  updatedAt: Date.now(),
                  activeRunIds: [],
                  hasActiveRun: false,
                },
              ],
            },
          },
          "sessions.messages.subscribe": { subscribed: true },
          "chat.history": {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: historyText }],
                __openclaw: { id: "native-history" },
              },
            ],
            sessionInfo: { hasActiveRun: false, activeRunIds: [] },
          },
          "question.list": { questions: [] },
          "exec.approval.list": [],
          "models.list": {
            models: [{ id: "model", name: "Model", provider: "test" }],
          },
        }
        const payload =
          frame.method === "connect"
            ? {
                type: "hello-ok",
                protocol: 4,
                server: { version: "2026.8.1", connId: "e2e" },
                features: {
                  methods: Object.keys(responses),
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
                  scopes: ["operator.read", "operator.write"],
                },
                policy: {
                  maxPayload: 1_000_000,
                  maxBufferedBytes: 1_000_000,
                  tickIntervalMs: 30_000,
                },
              }
            : (responses[frame.method] ?? { ok: true })
        queueMicrotask(() =>
          this.message({ type: "res", id: frame.id, ok: true, payload })
        )
      }
      close(code = 1000, reason = "") {
        this.readyState = NativeSocket.CLOSED
        this.dispatchEvent(new CloseEvent("close", { code, reason }))
      }
      private message(value: unknown) {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(value) })
        )
      }
    }
    Object.assign(NativeSocket.prototype, {
      binaryType: "blob",
      bufferedAmount: 0,
      extensions: "",
      protocol: "",
    })
    Object.defineProperty(window, "WebSocket", { value: NativeSocket })
  })

  await page.goto("/en")
  await expect(
    page.getByRole("tab", { name: "OpenClaw Session" })
  ).toBeVisible()
  await page.getByRole("tab", { name: "OpenClaw Session" }).click()
  await expect(page.getByText("Native OpenClaw history")).toBeVisible()
  const gatewayURL = await page.evaluate(
    () =>
      (window as unknown as { __openclawRequests: Array<{ method: string }> })
        .__openclawRequests
  )
  expect(gatewayURL.some(({ method }) => method === "connect")).toBe(true)
  expect(gatewayURL.some(({ method }) => method === "chat.history")).toBe(true)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __openclawSocketUrls: string[] })
          .__openclawSocketUrls
    )
  ).toEqual(["ws://127.0.0.1:3105/openclaw"])
  await expect(page.getByRole("button", { name: /regenerate/i })).toHaveCount(0)
})
