import { expect, test } from "./test"

const session = {
  id: "session-1",
  agentId: "research",
  title: "Research",
  archived: false,
  updatedAt: "2026-09-12T00:00:00.000Z",
  status: "idle",
}

const runtime = {
  runtime: { id: "hermes", name: "Hermes" },
  status: "ready",
  capabilities: {
    agentCatalog: { status: "available" },
    agentVisibility: { status: "available" },
    sessionCatalog: {
      status: "available",
      scope: "workspace",
      order: "recent",
      defaultPageSize: 50,
      maxPageSize: 100,
      maxWindow: 1000,
    },
    sessionHistory: {
      status: "available",
      order: "chronological",
      compacted: true,
      loading: "on-open",
      defaultPageSize: 200,
      maxPageSize: 500,
    },
    sessionDetail: { status: "available" },
    sessionCreation: { status: "available" },
    sessionTitle: { status: "available" },
    sessionArchival: { status: "available" },
    sessionDeletion: { status: "available" },
    sessionRun: { status: "available" },
    sessionStop: { status: "available" },
  },
}

test("AOS proxy gates auth, restores history, streams one turn, stops, and reconnects", async ({
  page,
}) => {
  let authenticated = false
  let stopRequests = 0
  let runRequests = 0

  await page.addInitScript(() => {
    class AOSSocket extends EventTarget {
      readyState = 0
      constructor() {
        super()
        queueMicrotask(() => {
          this.readyState = 1
          this.dispatchEvent(new Event("open"))
        })
      }
      send(raw: string) {
        const { scope, streamId } = JSON.parse(raw) as {
          scope: unknown
          streamId: string
        }
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "aos.ready",
                version: 1,
                streamId,
                scope,
                generation: 0,
                read: "authoritative",
              }),
            })
          )
        )
      }
      close() {
        this.readyState = 3
        this.dispatchEvent(new Event("close"))
      }
    }
    Object.defineProperty(window, "WebSocket", { value: AOSSocket })
  })

  await page.route("**/runtime-config.json", (route) =>
    route.fulfill({ json: { mode: "aos" } })
  )
  await page.route("**/api/aos/v1/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.endsWith("/auth/operator"))
      return route.fulfill({
        json: authenticated
          ? { status: "authenticated", operator: { id: "operator" } }
          : { status: "unauthenticated" },
      })
    if (path.endsWith("/auth/runtime"))
      return route.fulfill({ json: { status: "authenticated" } })
    if (path.endsWith("/runtime")) return route.fulfill({ json: runtime })
    if (path.endsWith("/agents"))
      return route.fulfill({
        json: {
          revision: "catalog-1",
          agents: [
            {
              summary: {
                kind: "ready",
                id: "research",
                name: "Research",
                status: "idle",
              },
              visibility: "visible",
              selectable: true,
              editable: false,
              revision: "research-1",
            },
          ],
        },
      })
    if (path.endsWith("/sessions"))
      return route.fulfill({
        json: { sessions: [session], total: 1, limit: 50, offset: 0 },
      })
    if (path.endsWith("/history"))
      return route.fulfill({
        json: {
          sessionId: session.id,
          messages: [
            {
              id: "history-1",
              role: "assistant",
              content: [{ type: "text", text: "Restored from AOS." }],
              createdAt: "2026-09-12T00:00:00.000Z",
            },
          ],
          total: 1,
          limit: 200,
          offset: 0,
          nextOffset: 1,
        },
      })
    if (path.endsWith("/workspace/models"))
      return route.fulfill({
        json: { selectedId: "default", options: [{ id: "default", label: "Default", group: "Hermes" }] },
      })
    if (path.endsWith("/workspace/context"))
      return route.fulfill({
        json: { usedTokens: 1, maxTokens: 100, source: "provider-usage" },
      })
    if (path.endsWith("/workspace/todos"))
      return route.fulfill({ json: { todos: [] } })
    if (path.endsWith("/interactions/pending"))
      return route.fulfill({
        json: { runId: "run-1", running: false, status: "idle" },
      })
    if (path.endsWith("/workspace/activity"))
      return route.fulfill({
        json: {
          status: "available",
          scope: "attached-active-session",
          coverage: "active-session-only",
          state: "idle",
        },
      })
    if (path.endsWith("/audio"))
      return route.fulfill({
        json: {
          transcription: { status: "unavailable", reason: "not-configured" },
          speech: { status: "unavailable", reason: "not-configured" },
        },
      })
    if (path.endsWith("/runs/stop")) {
      stopRequests++
      return route.fulfill({ status: 202, json: { status: "stopping" } })
    }
    if (path.endsWith("/runs")) {
      runRequests++
      return route.fulfill({
        contentType: "text/event-stream",
        body: [
          'data: {"type":"RUN_STARTED","threadId":"session-1","runId":"run-1"}',
          'data: {"type":"TEXT_MESSAGE_START","threadId":"session-1","messageId":"answer-1"}',
          'data: {"type":"TEXT_MESSAGE_CONTENT","threadId":"session-1","messageId":"answer-1","delta":"Streamed by AOS."}',
          'data: {"type":"TEXT_MESSAGE_END","threadId":"session-1","messageId":"answer-1"}',
          'data: {"type":"RUN_FINISHED","threadId":"session-1","runId":"run-1","outcome":{"type":"success"}}',
          "",
        ].join("\n\n"),
      })
    }
    return route.fulfill({ status: 404, json: { error: { code: "not_found" } } })
  })

  await page.goto("/")
  await expect(page.getByRole("alert")).toContainText("Sign in to AOS")

  authenticated = true
  await page.reload()
  await expect(page.getByText("Restored from AOS.")).toBeVisible()

  await page.getByRole("textbox", { name: "Message input" }).fill("Send once")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByText("Streamed by AOS.")).toBeVisible()
  expect(runRequests).toBe(1)

  await page.evaluate(() =>
    fetch("/api/aos/v1/agents/research/sessions/session-1/runs/stop", {
      method: "POST",
    })
  )
  expect(stopRequests).toBe(1)

  await page.reload()
  await expect(page.getByText("Restored from AOS.")).toBeVisible()
})
