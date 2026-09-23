import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"

export type ProviderRequest = {
  method: string
  path: string
  body?: unknown
}

export type ProviderMockOptions = {
  port?: number
}

export type ProviderMock = {
  readonly origin: string
  readonly requests: readonly ProviderRequest[]
  readonly unexpectedRequests: readonly ProviderRequest[]
  readonly pendingQuestions: readonly unknown[]
  start(): Promise<void>
  stop(): Promise<void>
  failOnce(path: string, status?: number): void
  enqueueQuestion(question: unknown): void
}

const SESSION_CREATED = 1_788_268_800_000

/** A Session long enough that its history takes many pages to read. */
export const LONG_SESSION_ID = "session-long"
export const LONG_SESSION_LENGTH = 1_200

const openCodeSessions = [
  {
    id: "session-research",
    slug: "session-research",
    projectID: "keyboard-first",
    directory: "/workspace/keyboard-first",
    title: "Research history",
    agent: "build",
    version: "1",
    time: { created: SESSION_CREATED, updated: SESSION_CREATED },
  },
  {
    id: LONG_SESSION_ID,
    slug: LONG_SESSION_ID,
    projectID: "keyboard-first",
    directory: "/workspace/keyboard-first",
    title: "Long history",
    agent: "build",
    version: "1",
    time: { created: SESSION_CREATED, updated: SESSION_CREATED },
  },
]

/** Alternating synthetic turns, oldest first, in the v2 native shape. */
const longSessionMessages = Array.from(
  { length: LONG_SESSION_LENGTH },
  (_, index) => {
    const id = `long-${String(index).padStart(4, "0")}`
    const created = SESSION_CREATED + index * 1_000
    const text = `Long history message ${index}`
    return index % 2 === 0
      ? { id, type: "user", text, time: { created } }
      : {
          id,
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "test" },
          content: [{ id: `${id}-text`, type: "text", text }],
          finish: "stop",
          time: { created, completed: created + 500 },
        }
  }
)

const DEFAULT_MESSAGE_PAGE = 100

/**
 * One page of `GET /api/session/:id/message`. As in OpenCode, the first read
 * names an `order` and later reads pass only the opaque `cursor.next`, which
 * keeps that order; `desc` reads newest first.
 */
function messagePage(sessionId: string, query: URLSearchParams) {
  const cursor = /^(asc|desc)-(\d+)$/.exec(query.get("cursor") ?? "")
  const order = cursor?.[1] ?? query.get("order") ?? "asc"
  const start = cursor ? Number(cursor[2]) : 0
  const limit = Number(query.get("limit") ?? DEFAULT_MESSAGE_PAGE)
  const stored = sessionId === LONG_SESSION_ID ? longSessionMessages : []
  const ordered = order === "desc" ? [...stored].reverse() : stored
  const end = start + limit
  return {
    data: ordered.slice(start, end),
    cursor: end < ordered.length ? { next: `${order}-${end}` } : {},
  }
}

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

export function createProviderMock(
  options: ProviderMockOptions = {}
): ProviderMock {
  const requests: ProviderRequest[] = []
  const unexpectedRequests: ProviderRequest[] = []
  const failures = new Map<string, number>()
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
      (url.pathname === "/session" || url.pathname === "/experimental/session")
    )
      return json(response, openCodeSessions)
    if (request.method === "GET" && url.pathname === "/session/status")
      return json(response, {
        "session-research": { type: "idle" },
        [LONG_SESSION_ID]: { type: "idle" },
      })
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
    const messages = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/)
    if (request.method === "GET" && messages?.[1])
      return json(response, messagePage(messages[1], url.searchParams))
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
      if (!server.listening) return
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    },
    failOnce(path, status = 500) {
      failures.set(path, status)
    },
    enqueueQuestion(question) {
      questions.push(question)
    },
  }
}
