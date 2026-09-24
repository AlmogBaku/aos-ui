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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { INTERACTION_PROTOCOL } from "@aos/protocol"
import {
  AOS_AUTH_METHOD_INVITE,
  AOS_JSONRPC_ERRORS,
  AOS_META_KEY,
  AOS_METHODS,
  AosComposerPrefillNotificationSchema,
  AosPromptMetaSchema,
  AosSteerRequestSchema,
} from "@aos/protocol/acp"

import { en } from "@/lib/i18n/dictionaries/en"

import { fetchGuestRuntimeContext, GuestAosSurface } from "./guest-composition"

const AGENT_ID = "researcher"
const REF = "guest_ref"
const TOKEN = "invitation.token"
const BASE_PATH = "/api/guest/v1"

const unavailable = { status: "unavailable", reason: "not-supported" } as const

const steeringAvailable = {
  status: "available",
  scope: "active-turn",
  semantics: "visible-user-message",
  input: "text",
  fallback: "provider-queue",
} as const

/** What the guest lane reports for the invited Session on `session/resume`. */
function capabilities(options: { steering?: boolean } = {}) {
  return {
    workspace: {
      slashCommands: unavailable,
      models: unavailable,
      context: unavailable,
      todos: unavailable,
      activity: unavailable,
    },
    interactions: {
      steering: options.steering ? steeringAvailable : unavailable,
      approvals: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "turn",
        choices: [{ value: "once", scope: "request" }],
        maxPending: 1,
      },
      questions: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "turn",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-cancel",
        maxQuestions: 1,
        maxChoicesPerQuestion: 4,
        maxAnswerValuesPerQuestion: "complete-request",
        maxStringBytes: 4096,
      },
      reactions: unavailable,
    },
    content: {
      attachments: unavailable,
      artifacts: unavailable,
      mcpApps: unavailable,
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
    capabilities: { content: {}, interactions: {} },
    expiresAt: "2026-09-22T08:00:00.000Z",
  }
}

/** The `_aos/composer_prefill` params the guest lane sends after a run. */
const prefillParams = (text: string) => ({
  sessionId: REF,
  turnId: "run-1",
  text,
})

const authenticationRequired = () =>
  new RequestError(
    AOS_JSONRPC_ERRORS.authenticationRequired,
    "authentication_required"
  )

type GuestProxyOptions = {
  token?: string
  /** Whether the invited Session reports steering as available. */
  steering?: boolean
  /** Keeps every run going until `finishRun` settles it. */
  holdRuns?: boolean
}

/** The guest lane of the AOS proxy, in process: one invited conversation. */
function createGuestProxyAgent(options: GuestProxyOptions = {}) {
  const accepted = options.token ?? TOKEN
  const calls: string[] = []
  const prompts: PromptRequest[] = []
  const steers: unknown[] = []
  let peer: AgentContext | undefined
  let redeemed = false
  // The proxy streams a Session only to a client attached to it, so updates
  // raised before the resume wait for the replay that carries them.
  const waiting: SessionUpdate[] = [
    {
      sessionUpdate: "user_message",
      messageId: "history-0",
      content: [{ type: "text", text: "Earlier guest question" }],
      _meta: { [AOS_META_KEY]: { turnId: "run-0", sequence: 0 } },
    },
    {
      sessionUpdate: "agent_message",
      messageId: "history-1",
      content: [{ type: "text", text: "Earlier guest answer" }],
      _meta: { [AOS_META_KEY]: { turnId: "run-0", sequence: 1 } },
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
              // The guest lane carries the operator's conversation controls.
              steer: true,
              rewind: true,
              composerPrefill: true,
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
            capabilities: capabilities(options),
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
          sessionUpdate: "state_update",
          state: "running",
          _meta: { [AOS_META_KEY]: { turnId: "run-1", sequence: 0 } },
        })
        push({
          sessionUpdate: "user_message",
          messageId,
          content: params.prompt,
          _meta: { [AOS_META_KEY]: { turnId: "run-1", sequence: 1 } },
        })
        // The guest lane allowlists its output: reasoning and tool calls are
        // dropped server-side, so only prose reaches this surface.
        push({
          sessionUpdate: "agent_message",
          messageId: `answer-${prompts.length}`,
          content: [{ type: "text", text: "Guest-visible answer" }],
          _meta: { [AOS_META_KEY]: { turnId: "run-1", sequence: 2 } },
        })
        if (!options.holdRuns) finishRun()
      })
      return { _meta: { [AOS_META_KEY]: { messageId } } }
    })
    .onRequest(AOS_METHODS.session.steer, z.unknown(), ({ params }) => {
      steers.push(params)
      return { status: "steered" as const }
    })
    .onNotification(methods.agent.session.cancel, () => {
      calls.push(methods.agent.session.cancel)
    })
    .onConnect((connection) => {
      peer = connection.client
    })

  function finishRun() {
    push({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
      _meta: { [AOS_META_KEY]: { turnId: "run-1", sequence: 3 } },
    })
  }

  return {
    app,
    calls,
    prompts,
    steers,
    finishRun,
    /** The provider's suggested next turn for the invited composer. */
    suggestPrefill(text: string) {
      void peer?.notify(AOS_METHODS.notify.composerPrefill, prefillParams(text))
    },
    /**
     * A question raised inside a tool call the guest lane dropped, so the
     * browser never saw the call it names.
     */
    askQuestion() {
      return peer?.request(methods.client.elicitation.create, {
        mode: "form",
        sessionId: REF,
        toolCallId: "hidden-tool-1",
        message: "The runtime needs an answer",
        requestedSchema: {
          type: "object",
          properties: { q0: { type: "string", enum: ["Yes", "No"] } },
        },
        _meta: {
          [AOS_META_KEY]: {
            requestId: "question-1",
            questions: [
              {
                header: "Confirm",
                prompt: "Continue the interview?",
                options: [{ label: "Yes" }, { label: "No" }],
                multiple: false,
                custom: false,
              },
            ],
          },
        },
      })
    },
    askPermission(): Promise<RequestPermissionResponse> | undefined {
      return peer?.request(methods.client.session.requestPermission, {
        sessionId: REF,
        title: "Delete the notes?",
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
        _meta: { [AOS_META_KEY]: { requestId: "interrupt-1" } },
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

function mount({
  inviteToken,
  ...options
}: GuestProxyOptions & { inviteToken?: string } = {}) {
  stubMatchMedia()
  const proxy = createGuestProxyAgent(options)
  vi.stubGlobal("WebSocket", pipedSocket(proxy.app))
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${BASE_PATH}/runtime`)
      return Response.json(guestRuntimeContext())
    if (url.endsWith(`/sessions/${REF}/attachments/stage`))
      return Response.json({
        stageId: "stage-1",
        attachments: [
          { type: "file", filename: "brief.txt", mimeType: "text/plain" },
        ],
      })
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal("fetch", fetcher)
  render(
    <GuestAosSurface
      config={{
        status: "ready",
        surface: "guest",
        basePath: BASE_PATH,
        lane: "guest",
      }}
      inviteToken={inviteToken ?? TOKEN}
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

  it("answers a permission request on its approval card", async () => {
    const user = userEvent.setup()
    const { proxy } = mount()
    await screen.findByText("Earlier guest answer")

    const answered = proxy.askPermission()

    const card = await screen.findByRole("group", { name: "Delete the notes?" })
    expect(
      screen.queryByRole("button", { name: "Send answer" })
    ).not.toBeInTheDocument()
    await user.click(within(card).getByRole("button", { name: "Allow once" }))

    await expect(answered).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "once" },
    })
  })

  it("answers a question in the composer even when its tool call never showed", async () => {
    const user = userEvent.setup()
    const { proxy } = mount()
    await screen.findByText("Earlier guest answer")

    const answered = proxy.askQuestion()

    expect(await screen.findByText("Continue the interview?")).toBeVisible()
    await user.click(screen.getByText("Yes"))
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    await expect(answered).resolves.toMatchObject({
      action: "accept",
      content: { q0: "Yes" },
    })
    // The call the question names was dropped server-side, so none appears.
    expect(screen.queryAllByRole("button", { name: /tool call/iu })).toEqual([])
  })

  it("keeps operator notification surfaces out of the invited lane", async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal(
      "Notification",
      Object.assign(vi.fn(), { permission: "default", requestPermission })
    )
    const register = vi.fn()
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    })
    try {
      const { fetcher } = mount()
      await screen.findByText("Earlier guest answer")

      expect(screen.queryByText(en.activity.settings)).toBeNull()
      expect(screen.queryByText(en.activity.askTitle)).toBeNull()
      expect(requestPermission).not.toHaveBeenCalled()
      expect(register).not.toHaveBeenCalled()
      // An invited guest never subscribes this device to operator alerts.
      expect(
        fetcher.mock.calls.filter(([input]) => String(input).includes("/push"))
      ).toEqual([])
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker")
    }
  })

  /** Replaces whatever the composer holds with one guest turn. */
  async function sendTurn(
    user: ReturnType<typeof userEvent.setup>,
    text: string
  ) {
    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      `{Control>}a{/Control}${text}`
    )
    await user.keyboard("{Enter}")
  }

  it("edits an earlier turn by rewinding the provider turn it replaces", async () => {
    const user = userEvent.setup()
    const { proxy } = mount()
    await screen.findByText("Earlier guest answer")

    // An earlier turn shows its actions while the guest points at it.
    await user.hover(screen.getByText("Earlier guest question"))
    await user.click(screen.getByRole("button", { name: "Edit message" }))
    const editor = screen
      .getAllByRole("textbox")
      .find(
        (box) => (box as HTMLTextAreaElement).value === "Earlier guest question"
      )
    expect(editor).toBeDefined()
    await user.clear(editor!)
    await user.type(editor!, "A better question")
    await user.click(screen.getByRole("button", { name: "Update" }))

    await waitFor(() => expect(proxy.prompts).toHaveLength(1))
    expect(proxy.prompts[0]).toMatchObject({
      sessionId: REF,
      prompt: [{ type: "text", text: "A better question" }],
      _meta: { [AOS_META_KEY]: { rewindSourceId: "history-0" } },
    })
    expect(
      AosPromptMetaSchema.safeParse(proxy.prompts[0]?._meta?.[AOS_META_KEY])
        .success
    ).toBe(true)
  })

  it("links a staged attachment batch from the guest prompt", async () => {
    const user = userEvent.setup()
    const { proxy, fetcher } = mount()
    await screen.findByText("Earlier guest answer")

    const composer = screen.getByRole("textbox", { name: "Message input" })
    fireEvent.paste(composer, {
      clipboardData: {
        files: [new File(["notes"], "brief.txt", { type: "text/plain" })],
      },
    })
    await screen.findByRole("button", { name: "Remove attachment" })
    await sendTurn(user, "Read the brief")

    await waitFor(() => expect(proxy.prompts).toHaveLength(1))
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).endsWith(`/sessions/${REF}/attachments/stage`)
      )
    ).toBe(true)
    const meta = proxy.prompts[0]?._meta?.[AOS_META_KEY]
    expect(meta).toEqual({ attachmentStageId: "stage-1" })
    expect(AosPromptMetaSchema.safeParse(meta).success).toBe(true)
  })

  it("steers the running turn when the invited Session allows steering", async () => {
    const user = userEvent.setup()
    const { proxy } = mount({ steering: true, holdRuns: true })
    await screen.findByText("Earlier guest answer")
    await sendTurn(user, "Start the interview")
    expect(await screen.findByText("Guest-visible answer")).toBeVisible()

    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "Focus on pricing"
    )
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}")

    await waitFor(() =>
      expect(proxy.steers).toEqual([
        {
          sessionId: REF,
          requestId: expect.any(String),
          text: "Focus on pricing",
        },
      ])
    )
    expect(AosSteerRequestSchema.safeParse(proxy.steers[0]).success).toBe(true)
    expect(proxy.prompts).toHaveLength(1)
  })

  it("does not steer when the invited Session reports steering unavailable", async () => {
    const user = userEvent.setup()
    const { proxy } = mount({ holdRuns: true })
    await screen.findByText("Earlier guest answer")
    await sendTurn(user, "Start the interview")
    expect(await screen.findByText("Guest-visible answer")).toBeVisible()

    const composer = screen.getByRole("textbox", { name: "Message input" })
    await user.type(composer, "Focus on pricing")
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}")

    expect(proxy.steers).toEqual([])
    expect(proxy.prompts).toHaveLength(1)
    expect(composer).toHaveValue("Focus on pricing")
  })

  it("fills an empty composer with the suggested turn once the run settles", async () => {
    const user = userEvent.setup()
    const { proxy } = mount({ holdRuns: true })
    await screen.findByText("Earlier guest answer")
    await sendTurn(user, "Start the interview")
    expect(await screen.findByText("Guest-visible answer")).toBeVisible()
    const composer = screen.getByRole("textbox", { name: "Message input" })

    proxy.suggestPrefill("What about pricing?")
    // A suggestion waits for the run it came from to settle.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(composer).toHaveValue("")

    proxy.finishRun()
    await waitFor(() => expect(composer).toHaveValue("What about pricing?"))
    expect(
      AosComposerPrefillNotificationSchema.safeParse(
        prefillParams("What about pricing?")
      ).success
    ).toBe(true)
  })

  it("never lets a suggested turn overwrite what the guest typed", async () => {
    const user = userEvent.setup()
    const { proxy } = mount({ holdRuns: true })
    await screen.findByText("Earlier guest answer")
    await sendTurn(user, "Start the interview")
    expect(await screen.findByText("Guest-visible answer")).toBeVisible()
    const composer = screen.getByRole("textbox", { name: "Message input" })
    await user.type(composer, "My own follow-up")

    proxy.suggestPrefill("What about pricing?")
    proxy.finishRun()

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /stop/iu })).toBeNull()
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(composer).toHaveValue("My own follow-up")
  })
})
