import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"

import { expect, test } from "@playwright/test"

const providerPort = 4103
const providerOrigin = `http://127.0.0.1:${providerPort}`

type RunRequest = {
  threadId?: string
  runId?: string
  messages?: Array<Record<string, unknown>>
  context?: Array<{ description?: string; value?: string }>
  tools?: Array<{
    name?: string
    description?: string
    parameters?: Record<string, unknown>
  }>
}

type WorkspaceSession = {
  threadId: string
  agentId: string
  title: string
  updatedAt: string
  status: "idle"
}

const sessions: WorkspaceSession[] = [
  {
    threadId: "session-research",
    agentId: "research",
    title: "Research history",
    updatedAt: "2026-09-04T09:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "session-writer",
    agentId: "writer",
    title: "Writer history",
    updatedAt: "2026-09-04T08:00:00.000Z",
    status: "idle",
  },
]

let provider: Server | undefined
const runRequests: RunRequest[] = []

function sse(events: readonly Record<string, unknown>[]) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")
}

async function body(request: IncomingMessage) {
  let text = ""
  for await (const chunk of request) text += chunk
  return text ? (JSON.parse(text) as RunRequest) : {}
}

function respondJson(response: ServerResponse, payload: unknown) {
  response.writeHead(200, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
  })
  response.end(JSON.stringify(payload))
}

function sessionHistory(threadId: string) {
  return {
    messages: [
      {
        id: `${threadId}-history`,
        role: "assistant",
        content: `Loaded AG-UI history for ${threadId}.`,
      },
    ],
  }
}

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", providerOrigin)
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-origin": "*",
        })
        response.end()
        return
      }
      if (request.method === "GET" && url.pathname === "/agents") {
        respondJson(response, [
          { id: "research", name: "Research", status: "idle" },
          { id: "writer", name: "Writer", status: "idle" },
        ])
        return
      }
      if (request.method === "GET" && url.pathname === "/sessions") {
        respondJson(response, sessions)
        return
      }
      const history = url.pathname.match(/^\/sessions\/([^/]+)$/)
      if (request.method === "GET" && history) {
        respondJson(response, sessionHistory(decodeURIComponent(history[1]!)))
        return
      }
      if (request.method === "POST" && url.pathname === "/runs") {
        const run = await body(request)
        runRequests.push(run)
        const runId = run.runId ?? "missing-run-id"
        const threadId = run.threadId ?? "missing-thread-id"
        response.writeHead(200, {
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        })
        response.end(
          sse(
            [
              { type: "RUN_STARTED", runId },
              { type: "TEXT_MESSAGE_START", messageId: "ag-ui-answer" },
              {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: "ag-ui-answer",
                delta: `AG-UI delivered a live response for ${
                  run.messages?.at(-1)?.content ?? "the submitted prompt"
                }.`,
              },
              {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: "ag-ui-answer",
                delta:
                  "\n\n```mermaid\nflowchart LR\n  Request --> Response\n```",
              },
              { type: "TEXT_MESSAGE_END", messageId: "ag-ui-answer" },
              { type: "RUN_FINISHED", runId, outcome: { type: "success" } },
            ].map((event) => ({ ...event, threadId }))
          )
        )
        return
      }
      response.writeHead(404, { "access-control-allow-origin": "*" })
      response.end("not found")
    })().catch((error: unknown) => {
      response.writeHead(500, { "access-control-allow-origin": "*" })
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve) =>
    provider!.listen(providerPort, "127.0.0.1", resolve)
  )
})

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider?.close((error) => (error ? reject(error) : resolve()))
  )
})

test("the configured AG-UI runtime advertises and renders only common presentation guidance", async ({
  page,
}) => {
  await page.goto("/en")

  await expect(
    page.getByRole("button", { name: /^Research(?:,|$)/ })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: /^Writer(?:,|$)/ })
  ).toBeVisible()
  await expect(
    page.getByRole("tab", { name: "Research history" })
  ).toHaveAttribute("aria-selected", "true")
  await expect(
    page.getByText(/Loaded AG-UI history for session-research/)
  ).toBeVisible()

  await page.getByRole("button", { name: /^Writer(?:,|$)/ }).click()
  await expect(
    page.getByRole("tab", { name: "Writer history" })
  ).toHaveAttribute("aria-selected", "true")
  await expect(
    page.getByText(/Loaded AG-UI history for session-writer/)
  ).toBeVisible()

  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Ship it through AG-UI")
  await page.getByRole("button", { name: "Send message" }).click()

  await expect(
    page.getByText(/AG-UI delivered a live response for/)
  ).toContainText("Ship it through AG-UI")
  await expect(page.getByRole("img", { name: "Mermaid diagram" })).toBeVisible()
  await expect.poll(() => runRequests.length).toBe(1)

  expect(runRequests[0]).toEqual(
    expect.objectContaining({
      threadId: "session-writer",
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Ship it through AG-UI",
        }),
      ]),
      context: [
        expect.objectContaining({
          description: "system",
          value: expect.stringContaining("fenced `mermaid` blocks"),
        }),
      ],
    })
  )
  expect(runRequests[0]?.tools?.map((tool) => tool.name)).toContain(
    "present_artifact"
  )
  expect(JSON.stringify(runRequests[0]?.context)).not.toMatch(
    /render_chart|render_map|render_stats|present_plan|ask_user_question/
  )
})
