import { expect, test, type Page, type Route } from "@playwright/test"

const providerOrigin = "http://127.0.0.1:4097"
const now = 1_788_268_800_000

type ProviderSession = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  agent: string
  version: string
  time: { created: number; updated: number }
}

function session(id: string, agent: string, title: string): ProviderSession {
  return {
    id,
    slug: id,
    projectID: "browser-contract",
    directory: "/workspace/browser-contract",
    title,
    agent,
    version: "1",
    time: { created: now, updated: now },
  }
}

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function installOpenCodeProvider(
  page: Page,
  options: { running?: boolean } = {}
) {
  let running = options.running ?? false
  const sessions = [session("existing-session", "build", "Provider session")]
  const createdAgents: string[] = []
  const promptedAgents: string[] = []
  const promptParts: unknown[] = []
  const pendingQuestions: Array<{
    id: string
    sessionID: string
    questions: Array<{
      header: string
      question: string
      options: Array<{ label: string; description: string }>
      custom: boolean
    }>
  }> = []
  const questionReplies: Array<{ requestId: string; answers: unknown }> = []
  const revertedMessageIds: string[] = []
  const abortedSessionIds: string[] = []
  const existingMessages: Array<{
    info: Record<string, unknown>
    parts: Array<Record<string, unknown>>
  }> = [
    {
      info: {
        id: "provider-user-1",
        sessionID: "existing-session",
        role: "user",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        time: { created: now },
      },
      parts: [
        {
          id: "provider-user-1-text",
          sessionID: "existing-session",
          messageID: "provider-user-1",
          type: "text",
          text: "Make this response better",
        },
      ],
    },
    {
      info: {
        id: "provider-assistant-1",
        sessionID: "existing-session",
        role: "assistant",
        parentID: "provider-user-1",
        agent: "build",
        modelID: "test",
        providerID: "test",
        mode: "build",
        path: { cwd: "/workspace/browser-contract", root: "/workspace" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: now + 1, completed: now + 2 },
      },
      parts: [
        {
          id: "provider-assistant-1-text",
          sessionID: "existing-session",
          messageID: "provider-assistant-1",
          type: "text",
          text: "Initial provider response",
        },
      ],
    },
  ]

  await page.route(`${providerOrigin}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname

    if (path === "/global/event") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        },
        body: "",
      })
      return
    }

    if (path === "/agent") {
      await json(route, [
        {
          name: "build",
          description: "Browser-contract primary Agent",
          mode: "primary",
          permission: [],
          options: {},
        },
      ])
      return
    }

    if (
      path === "/experimental/session" ||
      (path === "/session" && request.method() === "GET")
    ) {
      await json(route, sessions)
      return
    }
    if (path === "/session/status") {
      await json(
        route,
        Object.fromEntries(
          sessions.map(({ id }) => [id, { type: running ? "busy" : "idle" }])
        )
      )
      return
    }
    if (path === "/permission") {
      await json(route, [])
      return
    }
    if (path === "/question") {
      await json(route, pendingQuestions)
      return
    }

    const questionReply = path.match(/^\/question\/([^/]+)\/reply$/)
    if (questionReply && request.method() === "POST") {
      const requestId = questionReply[1]!
      questionReplies.push({
        requestId,
        answers: (request.postDataJSON() as { answers?: unknown }).answers,
      })
      const index = pendingQuestions.findIndex(({ id }) => id === requestId)
      if (index >= 0) pendingQuestions.splice(index, 1)
      await json(route, true)
      return
    }

    if (path === "/session" && request.method() === "POST") {
      const payload = request.postDataJSON() as { agent?: string }
      const agent = payload.agent ?? "missing-agent"
      createdAgents.push(agent)
      const created = session("created-session", agent, "New session")
      sessions.unshift(created)
      await json(route, created)
      return
    }

    const match = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/)
    if (!match) {
      await json(route, {})
      return
    }
    const [, sessionId, resource] = match
    const current = sessions.find(({ id }) => id === sessionId)
    if (!current) {
      await route.fulfill({ status: 404, body: "not found" })
      return
    }
    if (resource === "message" && request.method() === "GET") {
      await json(
        route,
        sessionId === "existing-session" ? existingMessages : []
      )
      return
    }
    if (resource === "todo") {
      await json(route, [])
      return
    }
    if (resource === "prompt_async") {
      const payload = request.postDataJSON() as {
        agent?: string
        parts?: unknown[]
      }
      promptedAgents.push(payload.agent ?? "missing-agent")
      promptParts.push(payload.parts ?? [])
      if (sessionId === "existing-session") {
        const lastPart = existingMessages.at(-1)?.parts.at(-1)
        if (lastPart?.type === "tool" && lastPart.tool === "question") {
          existingMessages.push({
            info: {
              id: "provider-user-orphan-reply",
              sessionID: "existing-session",
              role: "user",
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              time: { created: now + 3 },
            },
            parts: (payload.parts ?? []).filter(isRecord),
          })
        } else {
          existingMessages[1]!.parts[0]!.text = "Regenerated provider response"
        }
      }
      await json(route, {})
      return
    }
    if (resource === "revert") {
      revertedMessageIds.push(
        (request.postDataJSON() as { messageID?: string }).messageID ??
          "missing"
      )
      await json(route, true)
      return
    }
    if (resource === "abort") {
      abortedSessionIds.push(sessionId!)
      running = false
      await json(route, true)
      return
    }
    if (!resource && request.method() === "GET") {
      await json(route, current)
      return
    }
    await json(route, {})
  })

  return {
    abortedSessionIds,
    createdAgents,
    pendingQuestions,
    promptedAgents,
    promptParts,
    questionReplies,
    revertedMessageIds,
    existingMessages,
  }
}

async function preventEventStreamConnection(page: Page) {
  await page.addInitScript(() => {
    // Keep the adapter's reconnect probe unavailable so the contract exercises
    // authoritative initial-load hydration only.
    AbortController.prototype.abort = function () {}
    const streamGate = new Promise<void>(() => {})
    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        window.location.href
      )
      if (url.pathname !== "/global/event" && url.pathname !== "/event") {
        return nativeFetch(input, init)
      }

      await streamGate
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"))
          },
        }),
        {
          headers: {
            "access-control-allow-origin": "*",
            "content-type": "text/event-stream",
          },
        }
      )
    }
  })
}

test("reattaches a running OpenCode Session on the initial stream connection", async ({
  page,
}) => {
  await preventEventStreamConnection(page)
  const provider = await installOpenCodeProvider(page, { running: true })

  await page.goto("/en")
  await expect(page.getByText("Initial provider response")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Stop generating" })
  ).toBeVisible()

  await page.reload()
  await expect(page.getByText("Initial provider response")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Stop generating" })
  ).toBeVisible()
  expect(provider.abortedSessionIds).toEqual([])

  const input = page.getByRole("textbox", { name: "Message input" })
  await input.fill("Wait until the running command finishes")
  await input.press("Enter")
  const queued = page.getByRole("region", { name: "Queued messages" })
  await expect(queued).toContainText("Wait until the running command finishes")
  expect(provider.promptedAgents).toEqual([])
  expect(provider.abortedSessionIds).toEqual([])

  await page.getByRole("button", { name: "Stop generating" }).click()
  await expect
    .poll(() => provider.abortedSessionIds)
    .toEqual(["existing-session"])
  await expect(queued).toContainText("Wait until the running command finishes")

  await page.goto("/en/missing-session")
  expect(provider.abortedSessionIds).toEqual(["existing-session"])
})

test("the default OpenCode workspace creates and prompts an Agent-owned Session", async ({
  page,
}) => {
  const provider = await installOpenCodeProvider(page)

  await page.goto("/en")
  await expect(page.getByRole("button", { name: "build" })).toBeVisible()
  await expect(
    page.getByRole("tab", { name: "Provider session" })
  ).toBeVisible()

  await page.getByRole("button", { name: "New session", exact: true }).click()
  await expect(
    page.getByRole("tab", { name: "New session", exact: true })
  ).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => provider.createdAgents).toEqual(["build"])

  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Provider contract prompt")
  await page.getByRole("button", { name: "Send message" }).click()

  await expect.poll(() => provider.promptedAgents).toEqual(["build"])
  expect(provider.promptParts[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: "Provider contract prompt",
      }),
    ])
  )
})

test("Retry response reverts then regenerates the visible OpenCode reply", async ({
  page,
}) => {
  const provider = await installOpenCodeProvider(page)

  await page.goto("/en")
  await expect(page.getByText("Initial provider response")).toBeVisible()
  await page.getByRole("button", { name: "Retry response" }).click()

  await expect
    .poll(() => provider.revertedMessageIds)
    .toEqual(["provider-user-1"])
  await expect.poll(() => provider.promptedAgents).toEqual(["build"])
  expect(provider.promptParts[0]).toEqual([
    { type: "text", text: "Make this response better" },
  ])

  // The controlled provider persists the regenerated reply. A normal OpenCode
  // SSE update refreshes this same history; reload makes the rendered state
  // deterministic without relying on a live network stream in CI.
  await page.reload()
  await expect(page.getByText("Regenerated provider response")).toBeVisible()
})

test("answers OpenCode's reserved native question through its provider endpoint", async ({
  page,
}) => {
  const provider = await installOpenCodeProvider(page)
  provider.pendingQuestions.push({
    id: "provider-question-1",
    sessionID: "existing-session",
    questions: [
      {
        header: "Approach",
        question: "How should the provider continue?",
        options: [
          { label: "Fast", description: "Make the smallest safe change" },
          { label: "Thorough", description: "Check every integration" },
        ],
        custom: true,
      },
    ],
  })

  await page.goto("/en")
  await expect(
    page.getByText("How should the provider continue?", { exact: true })
  ).toBeVisible()
  await page.getByRole("option", { name: /^Thorough/ }).click()
  await page.getByRole("button", { name: "Send answer" }).click()

  await expect
    .poll(() => provider.questionReplies)
    .toEqual([{ requestId: "provider-question-1", answers: [["Thorough"]] }])
  await expect(
    page.getByText("How should the provider continue?", { exact: true })
  ).toHaveCount(0)
})

test("recovers an orphaned question and accepts a normal user reply", async ({
  page,
}) => {
  const provider = await installOpenCodeProvider(page)
  provider.existingMessages[1]!.parts = [
    {
      id: "provider-question-tool",
      sessionID: "existing-session",
      messageID: "provider-assistant-1",
      type: "tool",
      callID: "lost-question-call",
      tool: "question",
      state: {
        status: "running",
        input: {
          questions: [
            {
              header: "Approach",
              question: "Which recovery path should we use?",
              options: [
                {
                  label: "Continue",
                  description: "Reply as the next normal turn",
                },
              ],
              custom: true,
            },
          ],
        },
        time: { start: now + 2 },
      },
    },
  ]

  await page.goto("/en")
  await expect(
    page.getByText("Which recovery path should we use?")
  ).toBeVisible()
  await expect(
    page.getByRole("textbox", { name: "Message input" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Send answer" })).toHaveCount(0)

  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Continue with the normal turn")
  await page.getByRole("button", { name: "Send message" }).click()

  await expect.poll(() => provider.promptedAgents).toEqual(["build"])
  expect(provider.questionReplies).toEqual([])
  await expect(
    page.getByText("Which recovery path should we use?")
  ).toHaveCount(0)
})
