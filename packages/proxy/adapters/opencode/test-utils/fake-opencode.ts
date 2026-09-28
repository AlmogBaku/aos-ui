/**
 * fakeOpenCode — one in-memory OpenCode server holding one Agent and one
 * Session, for the runtime and wire contracts: the HTTP routes and the durable
 * event stream a create, a turn and a read reach, and the faults the runtime
 * contract drives. It answers the real `createOpenCodeClient`, built by
 * `fakeOpenCodeClient`, through its `fetcher`, so the client's own status
 * mapping and credential tracking are what the contracts prove.
 *
 * It copies OpenCode 1.18.29 (`@opencode-ai/sdk` 1.18.29), its v2 Session API
 * behind basic auth, serving one project directory.
 *
 * Usage:
 *
 *   const opencode = fakeOpenCode()
 *   const client = fakeOpenCodeClient(opencode)
 *   opencode.progress() // stream a reply fragment into the running turn
 *
 * Every answer takes the shape the pinned SDK types for its route.
 */
import type { CallerError } from "../../../core/failures"
import * as ids from "../../../core/ids"
import { createOpenCodeClient, OpenCodeClientError } from "../client"

const AGENT_ID = "writer"
const SESSION_ID = "session-1"
const SESSION = {
  id: SESSION_ID,
  agent: AGENT_ID,
  title: "Contract Session",
  time: { created: 1_000, updated: 2_000 },
}
const NATIVE_FAILURE_STATUS = 500
/** The status OpenCode refuses a call with, by the caller error it means. */
const REFUSALS: Partial<Record<CallerError, number>> = {
  runtime_authentication_required: 401,
  invalid_request: 400,
  revision_conflict: 409,
}

type Fault = "none" | "native" | "refused" | "down"
type DurableEvent = Readonly<{
  id: string
  type: string
  durable: { aggregateID: string; seq: number; version: number }
  data: Record<string, unknown>
}>
/** An open answer the fake settles later: an event stream or a wait. */
type Held = Readonly<{
  push?(event: DurableEvent): void
  idle?(): void
  sever(): void
}>

function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}

function frame(event: DurableEvent) {
  const envelope = {
    id: String(event.durable.seq),
    event: "session",
    data: JSON.stringify(event),
  }
  return new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`)
}

/** The real client over `opencode`, as every contract composes it. */
export function fakeOpenCodeClient(opencode: FakeOpenCode) {
  return createOpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    directory: "/workspaces/contract",
    username: "operator",
    password: async () => "test-password",
    fetcher: opencode.fetcher,
  })
}

export type FakeOpenCode = ReturnType<typeof fakeOpenCode>

export function fakeOpenCode() {
  const log: DurableEvent[] = []
  const held = new Set<Held>()
  let fault: Fault = "none"
  let refusal = 0
  let deleted = false
  let running = false
  let calls = 0
  let replies = 0

  function append(type: string, data: Record<string, unknown>) {
    const seq = log.length
    const event: DurableEvent = {
      id: `native-${seq}`,
      type,
      durable: { aggregateID: SESSION_ID, seq, version: 1 },
      data: { sessionID: SESSION_ID, timestamp: 1_000 + seq, ...data },
    }
    log.push(event)
    for (const answer of held) answer.push?.(event)
    return event
  }

  /** An event stream replaying the log after `after`, then following it. */
  function stream(after: number, signal: AbortSignal) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of log)
          if (event.durable.seq > after) controller.enqueue(frame(event))
        const entry: Held = {
          push: (event) => controller.enqueue(frame(event)),
          sever: () => controller.error(new TypeError("terminated")),
        }
        held.add(entry)
        signal.addEventListener("abort", () => {
          held.delete(entry)
          controller.error(signal.reason)
        })
      },
    })
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })
  }

  /** A long poll that answers once the Session idles. */
  function wait(signal: AbortSignal) {
    if (!running) return new Response(null, { status: 204 })
    return new Promise<Response>((resolve, reject) => {
      const entry: Held = {
        idle: () => {
          held.delete(entry)
          resolve(new Response(null, { status: 204 }))
        },
        sever: () => {
          held.delete(entry)
          reject(new TypeError("fetch failed"))
        },
      }
      held.add(entry)
      signal.addEventListener("abort", () => {
        held.delete(entry)
        reject(signal.reason)
      })
    })
  }

  async function prompt(request: Request) {
    const body = (await request.json()) as {
      id: string
      prompt: { text: string }
    }
    running = true
    const admitted = append("session.next.prompt.admitted", {
      messageID: body.id,
      prompt: body.prompt,
      delivery: "queue",
    })
    return json({
      data: {
        admittedSeq: admitted.durable.seq,
        id: body.id,
        sessionID: SESSION_ID,
        prompt: body.prompt,
        delivery: "queue",
        timeCreated: 1,
      },
    })
  }

  async function route(request: Request) {
    const url = new URL(request.url)
    const after = Number(url.searchParams.get("after") ?? -1)
    const session = `/api/session/${SESSION_ID}`
    switch (url.pathname) {
      case "/api/agent":
        return json({
          data: [
            {
              id: AGENT_ID,
              mode: "primary",
              hidden: false,
              permissions: [],
              request: {},
            },
          ],
        })
      case "/api/session":
        // The release answers a create with the new Session; this fake's one
        // Session stands for it.
        if (request.method === "POST") return json({ data: SESSION })
        return json({ data: deleted ? [] : [SESSION], cursor: {} })
      case "/api/session/active":
        return json({
          data: running ? { [SESSION_ID]: { type: "running" } } : {},
        })
    }
    if (deleted) return json({}, 404)
    switch (url.pathname) {
      case session:
        return json({ data: SESSION })
      case `${session}/message`:
        return json({ data: [], cursor: {} })
      case `/session/${SESSION_ID}/todo`:
        return json([])
      case `${session}/history`:
        return json({
          data: log.filter(({ durable }) => durable.seq > after),
          hasMore: false,
        })
      case `${session}/event`:
        return stream(after, request.signal)
      case `${session}/prompt`:
        return prompt(request)
      case `${session}/wait`:
        return wait(request.signal)
    }
    return json({}, 404)
  }

  return {
    scope: {
      agentId: AGENT_ID,
      providerSessionId: ids.providerSessionId(SESSION_ID),
      sessionId: ids.sessionId(SESSION_ID),
    },

    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      const request =
        input instanceof Request ? input : new Request(String(input), init)
      if (fault === "down") throw new TypeError("fetch failed")
      if (fault === "refused") return json({}, refusal)
      if (fault === "native") return json({}, NATIVE_FAILURE_STATUS)
      return route(request)
    }) as typeof fetch,

    async progress() {
      replies += 1
      append("session.next.text.ended", {
        assistantMessageID: `assistant-${replies}`,
        textID: `text-${replies}`,
        text: "Contract reply",
      })
    },

    async finish() {
      running = false
      for (const answer of [...held]) answer.idle?.()
    },

    deleteSession() {
      deleted = true
    },

    /** OpenCode keeps no native body: the client's own error stands for it. */
    failNative() {
      fault = "native"
      return (error: unknown) =>
        error instanceof OpenCodeClientError && error.code === "unavailable"
    },

    refuseAsCaller(kind: CallerError) {
      const status = REFUSALS[kind]
      if (status === undefined)
        throw new Error(`OpenCode refuses no call as ${kind}`)
      fault = "refused"
      refusal = status
    },

    nativeCalls: () => calls,

    async dropLink() {
      fault = "down"
      for (const answer of [...held]) answer.sever()
    },

    async restoreLink() {
      fault = "none"
    },
  }
}
