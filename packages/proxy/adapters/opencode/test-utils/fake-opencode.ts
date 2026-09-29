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
 * Every answer takes the shape the pinned SDK types for its route. A Session's
 * questions reach only the server's own push, `GET /api/event`, as
 * `question.v2.*` events; its durable stream carries none.
 */
import type { CallerError } from "../../../core/failures"
import * as ids from "../../../core/ids"
import { createOpenCodeClient, OpenCodeClientError } from "../client"

const AGENT_ID = "writer"
/** The one project directory the server serves. */
export const PROJECT_DIRECTORY = "/workspaces/contract"
const SESSION_ID = "session-1"
const SESSION = {
  id: SESSION_ID,
  agent: AGENT_ID,
  title: "Contract Session",
  time: { created: 1_000, updated: 2_000 },
}
const MODEL = { providerID: "contract", id: "contract-model" }
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
/** One event of the server's own push, `GET /api/event`. */
type ServerEvent = Readonly<{
  id: string
  type: string
  properties: Record<string, unknown>
}>
/** An open answer the fake settles later: an event stream or a wait. */
type Held = Readonly<{
  push?(event: DurableEvent): void
  announce?(event: ServerEvent): void
  idle?(): void
  sever(): void
}>

function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}

/** When the event happened, which is also when what it stored was created. */
function created(event: DurableEvent) {
  return event.data.timestamp as number
}

function frame(event: DurableEvent) {
  const envelope = {
    id: String(event.durable.seq),
    event: "session",
    data: JSON.stringify(event),
  }
  return new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`)
}

/** The server's push frames each event as its own `V2Event` body. */
function serverFrame(event: ServerEvent) {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

/** The real client over `opencode`, as every contract composes it. */
export function fakeOpenCodeClient(opencode: FakeOpenCode) {
  return createOpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    directory: PROJECT_DIRECTORY,
    username: "operator",
    password: async () => "test-password",
    fetcher: opencode.fetcher,
  })
}

export type FakeOpenCode = ReturnType<typeof fakeOpenCode>

export function fakeOpenCode() {
  const log: DurableEvent[] = []
  /** The Session's stored messages, as `GET …/message` answers them. */
  const messages: Record<string, unknown>[] = []
  const held = new Set<Held>()
  let fault: Fault = "none"
  let refusal = 0
  let deleted = false
  let running = false
  let calls = 0
  let replies = 0
  let steps = 0
  let serverEvents = 0
  /** The question the running turn blocks on, and what settles its wait. */
  let asked:
    { request: Record<string, unknown>; settle: () => void } | undefined
  let nextQuestion = 1
  let interrupted: (() => void) | undefined

  function append(type: string, data: Record<string, unknown>) {
    const seq = log.length
    // The release versions a step's end apart from every other event.
    const version = type === "session.next.step.ended" ? 2 : 1
    const event: DurableEvent = {
      id: `native-${seq}`,
      type,
      durable: { aggregateID: SESSION_ID, seq, version },
      data: { sessionID: SESSION_ID, timestamp: Date.now(), ...data },
    }
    log.push(event)
    for (const answer of held) answer.push?.(event)
    return event
  }

  /** An event stream sending `replay`, then what `follow` hands it. */
  function sse(
    signal: AbortSignal,
    replay: readonly Uint8Array[],
    follow: (send: (chunk: Uint8Array) => void) => Omit<Held, "sever">
  ) {
    let entry: Held | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of replay) controller.enqueue(chunk)
        const open: Held = {
          ...follow((chunk) => controller.enqueue(chunk)),
          sever: () => controller.error(new TypeError("terminated")),
        }
        entry = open
        held.add(open)
        signal.addEventListener("abort", () => {
          held.delete(open)
          controller.error(signal.reason)
        })
      },
      // A reader that cancels the body closes it: nothing is sent to it again.
      cancel() {
        if (entry) held.delete(entry)
      },
    })
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })
  }

  /** An event stream replaying the log after `after`, then following it. */
  function stream(after: number, signal: AbortSignal) {
    return sse(
      signal,
      log.filter(({ durable }) => durable.seq > after).map(frame),
      (send) => ({ push: (event) => send(frame(event)) })
    )
  }

  /** The server's push, which replays nothing: it follows from now. */
  function serverStream(signal: AbortSignal) {
    return sse(signal, [], (send) => ({
      announce: (event) => send(serverFrame(event)),
    }))
  }

  function announce(type: string, properties: Record<string, unknown>) {
    serverEvents += 1
    const event = { id: `event-${serverEvents}`, type, properties }
    for (const answer of held) answer.announce?.(event)
  }

  /** The open question ends as `type` announces it; the turn goes on. */
  function endQuestion(
    type: "question.v2.replied" | "question.v2.rejected",
    fields: Record<string, unknown> = {}
  ) {
    if (!asked) return
    const { request, settle } = asked
    asked = undefined
    announce(type, { sessionID: SESSION_ID, requestID: request.id, ...fields })
    settle()
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
    messages.push({
      id: body.id,
      type: "user",
      text: body.prompt.text,
      time: { created: created(admitted) },
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

  /**
   * One model response, streamed and then stored as the release keeps it: an
   * assistant message per step, with its reasoning, text and calls as parts.
   */
  function step(parts: { reasoning?: string; text: string; read?: string }) {
    steps += 1
    const assistantMessageID = `assistant-step-${steps}`
    const started = append("session.next.step.started", {
      assistantMessageID,
      agent: AGENT_ID,
      model: MODEL,
    })
    const content: Record<string, unknown>[] = []
    if (parts.reasoning !== undefined) {
      const reasoningID = `reasoning-step-${steps}`
      append("session.next.reasoning.ended", {
        assistantMessageID,
        reasoningID,
        text: parts.reasoning,
      })
      content.push({
        id: reasoningID,
        type: "reasoning",
        text: parts.reasoning,
      })
    }
    const textID = `text-step-${steps}`
    append("session.next.text.ended", {
      assistantMessageID,
      textID,
      text: parts.text,
    })
    content.push({ id: textID, type: "text", text: parts.text })
    if (parts.read !== undefined) {
      const callID = `call-step-${steps}`
      const input = { filePath: parts.read }
      const output = [{ type: "text", text: "alice\nbob\ncarol" }]
      const provider = { executed: true }
      const called = append("session.next.tool.called", {
        assistantMessageID,
        callID,
        tool: "read",
        input,
        provider,
      })
      const succeeded = append("session.next.tool.success", {
        assistantMessageID,
        callID,
        structured: {},
        content: output,
        provider,
      })
      content.push({
        id: callID,
        type: "tool",
        name: "read",
        state: { status: "completed", input, content: output, structured: {} },
        time: { created: created(called), completed: created(succeeded) },
      })
    }
    const finish = parts.read === undefined ? "stop" : "tool-calls"
    const ended = append("session.next.step.ended", {
      assistantMessageID,
      finish,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    })
    messages.push({
      id: assistantMessageID,
      type: "assistant",
      agent: AGENT_ID,
      model: MODEL,
      content,
      finish,
      time: { created: created(started), completed: created(ended) },
    })
  }

  async function finish() {
    running = false
    for (const answer of [...held]) answer.idle?.()
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
      case "/api/event":
        return serverStream(request.signal)
    }
    if (deleted) return json({}, 404)
    switch (url.pathname) {
      case session:
        return json({ data: SESSION })
      case `${session}/message`:
        return json({ data: messages, cursor: {} })
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
      case `${session}/question`:
        return json({ data: asked ? [asked.request] : [] })
      case `${session}/permission`:
        return json({ data: [] })
      case `${session}/interrupt`:
        // An interrupt rejects the turn's open question at once; the turn
        // ends only once its loop stops.
        endQuestion("question.v2.rejected")
        interrupted?.()
        return new Response(null, { status: 204 })
    }
    const question = `${session}/question/${String(asked?.request.id)}`
    if (url.pathname === `${question}/reply`) {
      const { answers } = (await request.json()) as { answers: unknown }
      endQuestion("question.v2.replied", { answers })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === `${question}/reject`) {
      endQuestion("question.v2.rejected")
      return new Response(null, { status: 204 })
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

    finish,

    /** The wire contract's turn: two model responses, each its own step. */
    turn: {
      async firstResponse() {
        step({
          reasoning: "I should read the file.",
          text: "Reading the file.",
          read: "/tmp/demo.txt",
        })
      },
      async secondResponse(text = "The file lists three names.") {
        step({ text })
        await finish()
      },
      /** The turn's in-turn prompts, as the release's `question` tool asks. */
      questions: {
        ask: () =>
          new Promise<void>((settle) => {
            const request = {
              id: `question-${nextQuestion++}`,
              sessionID: SESSION_ID,
              questions: [
                {
                  header: "Proceed?",
                  question: "Proceed? yes / no",
                  options: [
                    { label: "yes", description: "Go on" },
                    { label: "no", description: "Stop here" },
                  ],
                  // `QuestionInfo.custom`: no typed answer beside the choices.
                  custom: false,
                },
              ],
            }
            asked = { request, settle }
            announce("question.v2.asked", request)
          }),
        /** Another client dismissed the question: the turn goes on. */
        async withdraw() {
          endQuestion("question.v2.rejected")
        },
        interrupted: () =>
          new Promise<void>((resolve) => {
            interrupted = () => {
              interrupted = undefined
              resolve()
            }
          }),
        /** The interrupted turn's loop stops: the Session idles. */
        confirmInterrupt: finish,
        held: {},
        lose: () =>
          Promise.reject(new Error("OpenCode lists every pending question")),
      },
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
