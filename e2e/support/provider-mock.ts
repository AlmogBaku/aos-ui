import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"

export type ProviderMode = "opencode" | "ag-ui"
export type ProviderRequest = {
  method: string
  path: string
  body?: unknown
}

export type ProviderMockOptions = {
  mode: ProviderMode
  port?: number
  run?: { hold?: boolean }
}

type PendingRun = { id: string; response: ServerResponse; threadId: string }

export type ProviderMock = {
  readonly origin: string
  readonly requests: readonly ProviderRequest[]
  readonly unexpectedRequests: readonly ProviderRequest[]
  readonly pendingRuns: readonly string[]
  readonly pendingQuestions: readonly unknown[]
  start(): Promise<void>
  stop(): Promise<void>
  releaseRun(runId?: string): void
  failOnce(path: string, status?: number): void
  enqueueQuestion(question: unknown): void
}

const sessions = [
  {
    threadId: "session-research",
    agentId: "research",
    title: "Research history",
    updatedAt: "2026-09-04T09:00:00.000Z",
    status: "idle",
  },
]

const openCodeSessions = [
  {
    id: "session-research",
    slug: "session-research",
    projectID: "keyboard-first",
    directory: "/workspace/keyboard-first",
    title: "Research history",
    agent: "build",
    version: "1",
    time: { created: 1_788_268_800_000, updated: 1_788_268_800_000 },
  },
]

function json(response: ServerResponse, payload: unknown, status = 200) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
  })
  response.end(JSON.stringify(payload))
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const text = await new Promise<string>((resolve, reject) => {
    let value = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => (value += chunk))
    request.on("end", () => resolve(value))
    request.on("error", reject)
  })
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function sse(runId: string, threadId: string) {
  return [
    { type: "RUN_STARTED", runId, threadId },
    { type: "TEXT_MESSAGE_START", messageId: `${runId}-message`, threadId },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: `${runId}-message`,
      threadId,
      delta: "Deterministic provider response.",
    },
    { type: "TEXT_MESSAGE_END", messageId: `${runId}-message`, threadId },
    { type: "RUN_FINISHED", runId, threadId, outcome: { type: "success" } },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")
}

export function createProviderMock(options: ProviderMockOptions): ProviderMock {
  const requests: ProviderRequest[] = []
  const unexpectedRequests: ProviderRequest[] = []
  const failures = new Map<string, number>()
  const pending = new Map<string, PendingRun>()
  const questions: unknown[] = []
  const server = createServer((request, response) => {
    void handle(request, response)
  })
  let port = options.port ?? 0

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const body = request.method === "POST" ? await readBody(request) : undefined
    const entry = { method: request.method ?? "GET", path: url.pathname, body }
    requests.push(entry)
    const failure = failures.get(url.pathname)
    if (failure !== undefined) {
      failures.delete(url.pathname)
      json(response, { error: "controlled provider failure" }, failure)
      return
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "content-type, x-opencode-directory",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-origin": "*",
      })
      response.end()
      return
    }

    if (options.mode === "ag-ui") {
      if (request.method === "GET" && url.pathname === "/agents")
        return json(response, [
          { id: "research", name: "Research", status: "idle" },
        ])
      if (request.method === "GET" && url.pathname === "/sessions")
        return json(response, sessions)
      if (request.method === "GET" && /^\/sessions\/[^/]+$/.test(url.pathname))
        return json(response, { messages: [] })
      if (request.method === "POST" && url.pathname === "/runs") {
        const run = (body ?? {}) as { runId?: string; threadId?: string }
        const id = run.runId ?? "missing-run-id"
        const threadId = run.threadId ?? "missing-thread-id"
        response.writeHead(200, {
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        })
        if (options.run?.hold) {
          response.write(": provider run held\\n\\n")
          pending.set(id, { id, response, threadId })
        } else {
          response.end(sse(id, threadId))
        }
        return
      }
    } else {
      if (url.pathname === "/global/event" || url.pathname === "/event") {
        response.writeHead(200, {
          "access-control-allow-origin": "*",
          "content-type": "text/event-stream",
        })
        response.end()
        return
      }
      if (request.method === "GET" && url.pathname === "/agent")
        return json(response, [
          {
            name: "build",
            description: "Test Agent",
            mode: "primary",
            permission: [],
            options: {},
          },
        ])
      if (request.method === "GET" && url.pathname === "/provider")
        return json(response, {
          connected: ["test"],
          all: [
            {
              id: "test",
              name: "Test",
              models: {
                test: {
                  id: "test",
                  name: "Test",
                  providerID: "test",
                  limit: { context: 65_536 },
                },
              },
            },
          ],
        })
      if (
        request.method === "GET" &&
        (url.pathname === "/session" ||
          url.pathname === "/experimental/session")
      )
        return json(response, openCodeSessions)
      if (request.method === "GET" && url.pathname === "/session/status")
        return json(response, { "session-research": { type: "idle" } })
      if (url.pathname === "/permission") return json(response, [])
      if (url.pathname === "/question") return json(response, questions)
      const questionReply = url.pathname.match(/^\/question\/[^/]+\/reply$/)
      if (request.method === "POST" && questionReply) {
        questions.shift()
        return json(response, true)
      }
      if (
        request.method === "POST" &&
        /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)
      )
        return json(response, {})
      if (
        request.method === "GET" &&
        /^\/session\/[^/]+\/message$/.test(url.pathname)
      )
        return json(response, [])
      if (
        request.method === "GET" &&
        /^\/session\/[^/]+\/todo$/.test(url.pathname)
      )
        return json(response, [])
      if (request.method === "GET" && /^\/session\/[^/]+$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[2]
        return json(
          response,
          openCodeSessions.find((session) => session.id === sessionId) ?? {}
        )
      }
    }
    unexpectedRequests.push(entry)
    response.writeHead(404, { "access-control-allow-origin": "*" })
    response.end("unexpected provider traffic")
  }

  return {
    get origin() {
      return `http://127.0.0.1:${port}`
    },
    requests,
    unexpectedRequests,
    get pendingRuns() {
      return [...pending.keys()]
    },
    pendingQuestions: questions,
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once("error", onError)
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError)
          const address = server.address()
          if (!address || typeof address === "string")
            return reject(new Error("Provider mock did not bind"))
          port = address.port
          resolve()
        })
      })
    },
    async stop() {
      for (const run of pending.values()) run.response.destroy()
      pending.clear()
      if (!server.listening) return
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    },
    releaseRun(runId) {
      const id = runId ?? pending.keys().next().value
      if (!id) return
      const run = pending.get(id)
      if (!run) throw new Error(`No pending run named ${id}`)
      pending.delete(id)
      run.response.end(sse(run.id, run.threadId))
    },
    failOnce(path, status = 500) {
      failures.set(path, status)
    },
    enqueueQuestion(question) {
      questions.push(question)
    },
  }
}
