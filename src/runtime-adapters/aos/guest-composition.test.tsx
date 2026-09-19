import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentContext,
  type AnyWireMessage,
  type PromptRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AOS_AUTH_METHOD_INVITE,
  AOS_JSONRPC_ERRORS,
  AOS_META_KEY,
} from "@aos/protocol/acp"

import { fetchGuestRuntimeContext, GuestAosSurface } from "./guest-composition"

const AGENT_ID = "researcher"
const REF = "guest_ref"
const TOKEN = "invitation.token"
const BASE_PATH = "/api/guest/v1"

const unavailable = { status: "unavailable", reason: "not-supported" } as const

/** What the guest lane reports for the invited Session on `session/resume`. */
function capabilities() {
  return {
    agent: {},
    workspace: {
      slashCommands: unavailable,
      models: unavailable,
      context: unavailable,
      todos: unavailable,
      activity: unavailable,
    },
    interactions: {
      steering: unavailable,
      approvals: {
        status: "available",
        protocol: "ag-ui-interrupt",
        scope: "run",
        choices: [{ value: "once", scope: "request" }],
        maxPending: 1,
      },
      questions: unavailable,
      reactions: unavailable,
    },
    content: {
      attachments: unavailable,
      artifacts: unavailable,
      transcription: unavailable,
      speech: unavailable,
    },
  }
}

const sessionInfo = { agentId: AGENT_ID, status: "idle", archived: false }

function guestRuntimeContext() {
  return {
    runtimeId: "hermes-primary",
    agentId: AGENT_ID,
    conversationRef: REF,
    ui: {
      lang: "en",
      name: "Research brand",
      logoUrl: "https://example.test/brand.png",
      accent: "#2563eb",
      title: "Research assistant",
      message: "Welcome to the conversation.",
    },
    prefill: "Hello from the invitation",
    capabilities: { agent: {}, content: {}, interactions: {} },
    expiresAt: "2026-09-22T08:00:00.000Z",
  }
}

const authenticationRequired = () =>
  new RequestError(
    AOS_JSONRPC_ERRORS.authenticationRequired,
    "authentication_required"
  )

/** The guest lane of the AOS proxy, in process: one invited conversation. */
function createGuestProxyAgent(options: { token?: string } = {}) {
  const accepted = options.token ?? TOKEN
  const calls: string[] = []
  const prompts: PromptRequest[] = []
  let peer: AgentContext | undefined
  let redeemed = false
  // The proxy streams a Session only to a client attached to it, so updates
  // raised before the resume wait for the replay that carries them.
  const waiting: SessionUpdate[] = [
    {
      sessionUpdate: "agent_message",
      messageId: "history-1",
      content: [{ type: "text", text: "Earlier guest answer" }],
      _meta: { [AOS_META_KEY]: { runId: "run-0", sequence: 0 } },
    },
  ]
  let attached = false

  function push(update: SessionUpdate) {
    if (attached)
      void peer?.notify(methods.client.session.update, {
        sessionId: REF,
        update,
      })
    else waiting.push(update)
  }

  function redeemedOrThrow() {
    if (!redeemed) throw authenticationRequired()
  }

  const app = agent({ name: "fake-guest-proxy" })
    .onRequest(methods.agent.initialize, () => {
      calls.push("initialize")
      return {
        protocolVersion: 2,
        info: { name: "aos-proxy", version: "1" },
        capabilities: { session: { prompt: { image: {} } } },
        authMethods: [
          {
            type: "agent" as const,
            methodId: AOS_AUTH_METHOD_INVITE,
            name: "Invitation",
          },
        ],
        _meta: {
          [AOS_META_KEY]: {
            version: 1,
            lane: "guest",
            extensions: {
              steer: false,
              rewind: false,
              artifacts: true,
              composerPrefill: false,
              agents: false,
              invalidation: false,
              activity: false,
              readState: false,
              focus: false,
              guestProjection: true,
            },
          },
        },
      }
    })
    .onRequest(methods.agent.auth.login, ({ params }) => {
      calls.push(methods.agent.auth.login)
      const meta = params._meta?.[AOS_META_KEY]
      const token =
        typeof meta === "object" && meta !== null && "token" in meta
          ? meta.token
          : undefined
      if (params.methodId !== AOS_AUTH_METHOD_INVITE || token !== accepted)
        throw authenticationRequired()
      redeemed = true
      return {}
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      calls.push(methods.agent.session.resume)
      redeemedOrThrow()
      queueMicrotask(() => {
        attached = true
        for (const update of waiting.splice(0))
          void peer?.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update,
          })
      })
      return {
        _meta: {
          [AOS_META_KEY]: {
            session: sessionInfo,
            execution: { status: "idle" },
            capabilities: capabilities(),
          },
        },
      }
    })
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      calls.push(methods.agent.session.prompt)
      redeemedOrThrow()
      prompts.push(params)
      const messageId = `prompt-${prompts.length}`
      queueMicrotask(() => {
        push({
          sessionUpdate: "user_message",
          messageId,
          content: params.prompt,
          _meta: { [AOS_META_KEY]: { runId: "run-1", sequence: 1 } },
        })
        // The guest lane allowlists its output: reasoning and tool calls are
        // dropped server-side, so only prose reaches this surface.
        push({
          sessionUpdate: "agent_message",
          messageId: `answer-${prompts.length}`,
          content: [{ type: "text", text: "Guest-visible answer" }],
          _meta: { [AOS_META_KEY]: { runId: "run-1", sequence: 2 } },
        })
        push({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
          _meta: { [AOS_META_KEY]: { runId: "run-1", sequence: 3 } },
        })
      })
      return { _meta: { [AOS_META_KEY]: { messageId } } }
    })
    .onNotification(methods.agent.session.cancel, () => {
      calls.push(methods.agent.session.cancel)
    })
    .onConnect((connection) => {
      peer = connection.client
    })

  return {
    app,
    calls,
    prompts,
    askPermission(): Promise<RequestPermissionResponse> | undefined {
      return peer?.request(methods.client.session.requestPermission, {
        sessionId: REF,
        title: "Delete the notes?",
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
        _meta: { [AOS_META_KEY]: { interruptId: "interrupt-1" } },
      })
    },
  }
}

/** A WebSocket-shaped pipe to the in-process guest agent. */
function pipedSocket(app: AgentApp) {
  return class PipedSocket extends EventTarget {
    readyState = 0
    readonly #inbound = new TransformStream<AnyWireMessage, AnyWireMessage>()
    readonly #writer: WritableStreamDefaultWriter<AnyWireMessage>

    constructor() {
      super()
      const outbound = new TransformStream<AnyWireMessage, AnyWireMessage>()
      app.connect({
        readable: this.#inbound.readable,
        writable: outbound.writable,
      })
      this.#writer = this.#inbound.writable.getWriter()
      void this.#pump(outbound.readable.getReader())
      queueMicrotask(() => {
        this.readyState = 1
        this.dispatchEvent(new Event("open"))
      })
    }

    async #pump(reader: ReadableStreamDefaultReader<AnyWireMessage>) {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(value) })
        )
      }
    }

    send(data: string) {
      void this.#writer.write(JSON.parse(data) as AnyWireMessage)
    }

    close() {
      this.readyState = 3
      this.dispatchEvent(new Event("close"))
    }
  }
}

function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }))
}

function mount(options: { token?: string; inviteToken?: string } = {}) {
  stubMatchMedia()
  const proxy = createGuestProxyAgent(
    options.token === undefined ? {} : { token: options.token }
  )
  vi.stubGlobal("WebSocket", pipedSocket(proxy.app))
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    String(input) === `${BASE_PATH}/runtime`
      ? Response.json(guestRuntimeContext())
      : new Response(null, { status: 404 })
  )
  vi.stubGlobal("fetch", fetcher)
  render(
    <GuestAosSurface
      config={{
        status: "ready",
        surface: "guest",
        basePath: BASE_PATH,
        lane: "guest",
      }}
      inviteToken={options.inviteToken ?? TOKEN}
      locale="en"
    />
  )
  return { proxy, fetcher }
}

describe("AOS guest browser composition", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("uses the gateway-verified context rather than decoded invitation claims", async () => {
    const fetcher = vi.fn(async () => Response.json(guestRuntimeContext()))

    await expect(
      fetchGuestRuntimeContext(fetcher, BASE_PATH, TOKEN)
    ).resolves.toEqual({
      agentId: AGENT_ID,
      conversationRef: REF,
      ui: {
        lang: "en",
        name: "Research brand",
        logoUrl: "https://example.test/brand.png",
        accent: "#2563eb",
        title: "Research assistant",
        message: "Welcome to the conversation.",
      },
      prefill: "Hello from the invitation",
    })
    expect(fetcher).toHaveBeenCalledWith(`${BASE_PATH}/runtime`, {
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
    })
  })

  it("redeems the invitation before it resumes the invited conversation", async () => {
    const { proxy } = mount()

    expect(await screen.findByText("Earlier guest answer")).toBeVisible()

    expect(proxy.calls).toEqual([
      "initialize",
      methods.agent.auth.login,
      methods.agent.session.resume,
    ])
    expect(screen.getByText("Research brand")).toBeVisible()
    expect(screen.getByRole("img", { name: "Research brand" })).toHaveAttribute(
      "src",
      "https://example.test/brand.png"
    )
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue(
        "Hello from the invitation"
      )
    )
    expect(document.documentElement).toHaveAttribute("lang", "en")
  })

  it("asks for a new invitation when the proxy refuses the token", async () => {
    const { proxy } = mount({ token: "another.token" })

    expect(
      await screen.findByText(
        "This invitation link is no longer active. Please ask the person who invited you to send a new one."
      )
    ).toBeInTheDocument()
    expect(proxy.calls).not.toContain(methods.agent.session.resume)
  })

  it("streams one guest turn without any execution detail", async () => {
    const user = userEvent.setup()
    const { proxy } = mount()
    await screen.findByText("Earlier guest answer")

    await user.type(
      await screen.findByRole("textbox"),
      "{Control>}a{/Control}Start the interview"
    )
    await user.keyboard("{Enter}")

    expect(await screen.findByText("Guest-visible answer")).toBeVisible()
    await waitFor(() => expect(proxy.prompts).toHaveLength(1))
    expect(proxy.prompts[0]).toMatchObject({
      sessionId: REF,
      prompt: [{ type: "text", text: "Start the interview" }],
    })
    // The invitation's first-turn instruction is applied by the proxy, so the
    // browser sends nothing beyond what the guest wrote.
    expect(proxy.prompts[0]?._meta).toEqual({ [AOS_META_KEY]: {} })
    // A guest-safe run carries no execution history, so the invited
    // conversation discloses neither reasoning nor a tool timeline.
    expect(
      screen.queryAllByRole("button", { name: /reasoning|tool call/iu })
    ).toEqual([])
  })

  it("answers a permission request through the shared pending composer", async () => {
    const user = userEvent.setup()
    const { proxy } = mount()
    await screen.findByText("Earlier guest answer")

    const answered = proxy.askPermission()

    await user.click(await screen.findByRole("option", { name: /Allow once/ }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    await expect(answered).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "once" },
    })
  })
})
