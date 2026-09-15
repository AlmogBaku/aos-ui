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
    sessionSteer: { status: "available" },
  },
}

const sessionCapabilities = {
  agent: {
    transport: { streaming: true, resumable: true },
    reasoning: { supported: true, streaming: true },
    multimodal: {
      input: { image: true, audio: false, file: true },
      output: { audio: false },
    },
    humanInTheLoop: {
      supported: true,
      approvals: true,
      interrupts: true,
    },
  },
  workspace: {
    slashCommands: {
      status: "available",
      scope: "attached-session",
      commands: Array.from({ length: 30 }, (_, index) => ({
        name: `command-${index}`,
        description: `Command ${index}`,
      })),
    },
    models: {
      status: "available",
      scope: "attached-session",
      selection: "native-session",
      choices: "provider-reported",
    },
    context: {
      status: "available",
      scope: "attached-session",
      source: "provider-usage-or-estimate",
      breakdown: "provider-categories",
    },
    todos: {
      status: "available",
      scope: "session",
      mode: "read-only-projection",
      source: "latest-completed-todo-tool-result",
    },
    activity: {
      status: "available",
      scope: "attached-active-session",
      coverage: "active-session-only",
      source: "session.info",
    },
  },
  interactions: {
    steering: {
      status: "available",
      scope: "active-run",
      semantics: "visible-user-message",
      input: "text",
      fallback: "provider-queue",
    },
    approvals: {
      status: "available",
      protocol: "ag-ui-interrupt",
      scope: "run",
      choices: [
        { value: "once", scope: "request" },
        { value: "session", scope: "session" },
        { value: "always", scope: "agent" },
        { value: "deny", scope: "request" },
      ],
      maxPending: 64,
    },
    questions: {
      status: "available",
      protocol: "ag-ui-interrupt",
      scope: "run",
      answerModes: ["single", "multiple", "free-text"],
      cancellation: "native-empty-answer",
      maxQuestions: 32,
      maxChoicesPerQuestion: 64,
      maxAnswerValuesPerQuestion: 64,
      maxStringBytes: 4096,
    },
    reactions: { status: "unavailable", reason: "not-supported" },
  },
  content: {
    attachments: {
      status: "available",
      scope: "attached-session",
      inputs: ["image", "file"],
      imageMimeTypes: ["image/png"],
      fileMimeTypes: "valid-type/subtype",
      maxMimeTypeBytes: 256,
      maxFilenameBytes: 255,
      maxCount: 16,
      maxImageBytes: 26_214_400,
      maxFileBytes: 26_214_400,
      maxTotalBytes: 26_214_400,
    },
    artifacts: { status: "unavailable", reason: "not-supported" },
    transcription: { status: "unavailable", reason: "not-configured" },
    speech: { status: "unavailable", reason: "not-configured" },
  },
}

test("AOS proxy restores history, offers commands, streams one turn, stops, and reconnects", async ({
  page,
}) => {
  let stopRequests = 0
  let runRequests = 0
  let reconnectRequests = 0
  let restoreActiveRun = false

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
        json: restoreActiveRun
          ? {
              sessionId: session.id,
              messages: [
                {
                  id: "refresh-user",
                  role: "user",
                  content: [{ type: "text", text: "Continue after refresh" }],
                  createdAt: "2026-09-12T00:00:01.000Z",
                },
                {
                  id: "refresh-partial",
                  role: "assistant",
                  content: [{ type: "text", text: "Partial before refresh" }],
                  createdAt: "2026-09-12T00:00:02.000Z",
                },
              ],
              total: 2,
              limit: 200,
              offset: 0,
              nextOffset: 2,
              execution: { status: "running", runId: "refresh-run" },
            }
          : {
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
    if (path.endsWith("/workspace/capabilities"))
      return route.fulfill({ json: sessionCapabilities })
    if (path.endsWith("/workspace/models"))
      return route.fulfill({
        json: {
          selectedId: "default",
          options: [{ id: "default", label: "Default", group: "Hermes" }],
        },
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
    if (path.endsWith("/runs/reconnect")) {
      reconnectRequests++
      const toolEvents = Array.from({ length: 11 }, (_, index) => [
        {
          type: "TOOL_CALL_START",
          toolCallId: `refresh-tool-${index}`,
          toolCallName: "search",
          parentMessageId: "refresh-answer",
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: `refresh-tool-${index}`,
          delta: "{}",
        },
        { type: "TOOL_CALL_END", toolCallId: `refresh-tool-${index}` },
        {
          type: "TOOL_CALL_RESULT",
          messageId: `refresh-result-${index}`,
          toolCallId: `refresh-tool-${index}`,
          content: `result-${index}`,
          role: "tool",
        },
      ]).flat()
      restoreActiveRun = false
      return route.fulfill({
        contentType: "text/event-stream",
        body: [
          {
            type: "RUN_STARTED",
            threadId: session.id,
            runId: "refresh-run",
          },
          {
            type: "REASONING_MESSAGE_START",
            messageId: "refresh-reasoning",
            role: "reasoning",
          },
          {
            type: "REASONING_MESSAGE_CONTENT",
            messageId: "refresh-reasoning",
            delta: "Recovered reasoning",
          },
          {
            type: "REASONING_MESSAGE_END",
            messageId: "refresh-reasoning",
          },
          {
            type: "TEXT_MESSAGE_START",
            messageId: "refresh-answer",
            role: "assistant",
          },
          ...toolEvents,
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "refresh-answer",
            delta: "Recovered after refresh.",
          },
          { type: "TEXT_MESSAGE_END", messageId: "refresh-answer" },
          {
            type: "RUN_FINISHED",
            threadId: session.id,
            runId: "refresh-run",
            outcome: { type: "success" },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}`)
          .concat("")
          .join("\n\n"),
      })
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
    return route.fulfill({
      status: 404,
      json: { error: { code: "not_found" } },
    })
  })

  await page.goto("/")
  await expect(page.getByText("Restored from AOS.")).toBeVisible()

  const input = page.getByRole("textbox", { name: "Message input" })
  await input.fill("/")
  const commandMenu = page.getByRole("listbox")
  await expect(commandMenu.getByRole("option")).toHaveCount(30)
  for (let index = 0; index < 15; index += 1) await input.press("ArrowDown")
  await expect
    .poll(() => commandMenu.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  await input.press("Escape")
  await input.fill("/command-2")
  await page.getByRole("option", { name: /^\/command-2\b/ }).click()
  await expect(input).toHaveValue("/command-2 ")

  await input.fill("Send once")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByText("Streamed by AOS.")).toBeVisible()
  expect(runRequests).toBe(1)

  await page.evaluate(() =>
    fetch("/api/aos/v1/agents/research/sessions/session-1/runs/stop", {
      method: "POST",
    })
  )
  expect(stopRequests).toBe(1)

  restoreActiveRun = true
  await page.reload()
  await expect(page.getByText("Recovered after refresh.")).toBeVisible()
  await expect(page.getByText("Partial before refresh")).toHaveCount(0)
  expect(runRequests).toBe(1)
  expect(reconnectRequests).toBe(1)
})
