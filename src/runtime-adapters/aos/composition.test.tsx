import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentContext,
  type AnyWireMessage,
  type PromptRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { lazy, Suspense, type ReactElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  HGW_EXTENSION_VERSION,
  HGW_JSONRPC_ERRORS,
  HGW_METHODS,
  HGW_META_KEY,
} from "@harness-gw/sdk/protocol"

import { AosUiWorkspace } from "../../components/aos-ui-workspace"
import { Thread } from "../../components/assistant-ui/elements/thread.aui"
import { en } from "../../lib/i18n/dictionaries/en"
import type { HarnessRuntime } from "../contracts"
import { runtimeAdapter } from "./composition"
import { sessionCapabilities, singleInteractions } from "./test-capabilities"

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: window.location.pathname }),
  useNavigate: () => (href: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"](
      null,
      "",
      href
    )
  },
}))

type PromptParams = PromptRequest

const AGENT_ID = "researcher"
const SESSION_ID = "session-1"
const SECOND_SESSION_ID = "session-2"
/** Older than the active window, so only a URL names it. */
const BOOKMARKED_SESSION_ID = "session-3"
const UPDATED_AT = "2026-09-19T10:00:00.000Z"
const BOOKMARKED_UPDATED_AT = "2026-09-17T09:00:00.000Z"

/** The catalog is paged, so a Session a URL names may sit past page one. */
const CATALOG_PAGES: readonly (readonly string[])[] = [
  [SESSION_ID, SECOND_SESSION_ID],
  [BOOKMARKED_SESSION_ID],
]

const SESSION_TITLES: Readonly<Record<string, string>> = {
  [SESSION_ID]: "Older",
  [SECOND_SESSION_ID]: "Newer",
  [BOOKMARKED_SESSION_ID]: "Bookmarked",
}

/** The capability snapshot `session/resume` reports for the opened Session. */
function capabilities({ rewind }: { rewind: boolean }) {
  return sessionCapabilities({
    interactions: {
      ...(rewind
        ? { rewind: { status: "available", scope: "user-turn" } as const }
        : {}),
      ...singleInteractions,
    },
  })
}

const sessionInfo = {
  agentId: AGENT_ID,
  status: "idle",
  archived: false,
  unread: false,
} as const

/** One task of latency, which every pending replay settles ahead of. */
const catalogLatency = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

/**
 * The gateway end of the operator connection, in process. Its Sessions report
 * they can rewind unless `rewind` says otherwise, and it forks only where
 * `forks` says so.
 */
function createGatewayAgent({
  rewind = true,
  forks = false,
}: { rewind?: boolean; forks?: boolean } = {}) {
  let peer: AgentContext | undefined
  const prompts: PromptParams[] = []
  const cancelled: string[] = []
  const resumed: string[] = []
  // The gateway keeps each Session's transcript and replays it from the start on
  // every such resume; it streams live updates only to a client that resumed it.
  const history = new Map<string, SessionUpdate[]>()
  const memberships = new Set<string>()
  const busy = new Set<string>()
  const created: string[] = []
  /** The Session each fork copied, in order. */
  const forked: string[] = []
  /** How many next `session/new` requests the provider refuses as unavailable. */
  const unavailable = { creates: 0 }

  function push(sessionId: string, update: SessionUpdate) {
    history.set(sessionId, [...(history.get(sessionId) ?? []), update])
    if (memberships.has(sessionId))
      void peer?.notify(methods.client.session.update, { sessionId, update })
  }

  history.set(SESSION_ID, [
    {
      sessionUpdate: "agent_message",
      messageId: "history-1",
      content: [{ type: "text", text: "Ready" }],
      _meta: { [HGW_META_KEY]: { turnId: "run-0", sequence: 0 } },
    },
  ])

  history.set(BOOKMARKED_SESSION_ID, [
    {
      sessionUpdate: "agent_message",
      messageId: "history-4",
      content: [{ type: "text", text: "Bookmarked answer" }],
      _meta: { [HGW_META_KEY]: { turnId: "run-0", sequence: 0 } },
    },
  ])

  history.set(SECOND_SESSION_ID, [
    {
      sessionUpdate: "user_message",
      messageId: "history-2",
      content: [{ type: "text", text: "Draft the plan" }],
      _meta: { [HGW_META_KEY]: { turnId: "run-0", sequence: 0 } },
    },
    {
      sessionUpdate: "agent_message",
      messageId: "history-3",
      content: [{ type: "text", text: "First answer" }],
      _meta: { [HGW_META_KEY]: { turnId: "run-0", sequence: 1 } },
    },
  ])

  const app = agent({ name: "fake-aos-gateway" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 2,
      info: { name: "harness-gw", version: "1" },
      ...(forks ? { capabilities: { session: { fork: {} } } } : {}),
      _meta: {
        [HGW_META_KEY]: {
          version: HGW_EXTENSION_VERSION,
          role: "operator",
          extensions: {
            steer: true,
            rewind: true,
            composerPrefill: true,
            agents: true,
            invalidation: true,
            activity: true,
            readState: true,
            focus: true,
            guestProjection: false,
          },
        },
      },
    }))
    .onRequest(methods.agent.session.list, async ({ params }) => {
      // A catalog page crosses the network, so a read that races a resume is
      // answered after the replay that resume streams first.
      await catalogLatency()
      const page = params.cursor === undefined ? 0 : Number(params.cursor)
      return {
        sessions: (CATALOG_PAGES[page] ?? []).map((sessionId) => ({
          sessionId,
          cwd: "/workspace",
          title: SESSION_TITLES[sessionId],
          updatedAt:
            sessionId === BOOKMARKED_SESSION_ID
              ? BOOKMARKED_UPDATED_AT
              : UPDATED_AT,
          _meta: { [HGW_META_KEY]: sessionInfo },
        })),
        ...(page + 1 < CATALOG_PAGES.length
          ? { nextCursor: String(page + 1) }
          : {}),
      }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      const { sessionId } = params
      resumed.push(sessionId)
      memberships.add(sessionId)
      // The gateway replays inside the resume request, before answering it, so a
      // browser that waits for the response has already seen the history.
      if (params.replayFrom?.type === "start")
        for (const update of history.get(sessionId) ?? [])
          await peer?.notify(methods.client.session.update, {
            sessionId,
            update,
          })
      // The Session's capabilities and row follow the answer as updates.
      setTimeout(() => {
        for (const update of [
          {
            sessionUpdate: "available_commands_update",
            availableCommands: [],
            _meta: {
              [HGW_META_KEY]: { capabilities: capabilities({ rewind }) },
            },
          },
          {
            sessionUpdate: "session_info_update",
            _meta: { [HGW_META_KEY]: sessionInfo },
          },
        ] satisfies SessionUpdate[])
          void peer?.notify(methods.client.session.update, {
            sessionId,
            update,
          })
      }, 0)
      return { _meta: { [HGW_META_KEY]: {} } }
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      if (unavailable.creates > 0) {
        unavailable.creates -= 1
        throw new RequestError(
          HGW_JSONRPC_ERRORS.temporarilyUnavailable,
          "provider_unavailable"
        )
      }
      const { agentId } = (params._meta?.[HGW_META_KEY] ?? {}) as {
        agentId?: string
      }
      created.push(agentId ?? "")
      return { sessionId: `created-${created.length}` }
    })
    .onRequest(methods.agent.session.fork, ({ params }) => {
      forked.push(params.sessionId)
      return { sessionId: `forked-${forked.length}` }
    })
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      // Exactly what the gateway refuses a prompt with while a Session is not idle.
      if (busy.has(params.sessionId))
        throw new RequestError(
          HGW_JSONRPC_ERRORS.turnInProgress,
          "turn_in_progress"
        )
      prompts.push(params)
      const messageId = `prompt-${prompts.length}`
      queueMicrotask(() => {
        push(params.sessionId, {
          sessionUpdate: "user_message",
          messageId,
          content: params.prompt,
          _meta: { [HGW_META_KEY]: { turnId: "run-1", sequence: 1 } },
        })
        push(params.sessionId, {
          sessionUpdate: "agent_message",
          messageId: `answer-${prompts.length}`,
          content: [{ type: "text", text: "Shipping it" }],
          _meta: { [HGW_META_KEY]: { turnId: "run-1", sequence: 2 } },
        })
      })
      return { messageId }
    })
    .onRequest(HGW_METHODS.agents.list, z.unknown().optional(), () => ({
      revision: "revision-1",
      agents: [
        {
          summary: { kind: "ready", id: AGENT_ID, name: "Researcher" },
          visibility: "visible",
          selectable: true,
          editable: true,
          avatarEditable: true,
          muteEditable: true,
          revision: "revision-1",
        },
      ],
    }))
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      cancelled.push(params.sessionId)
    })
    .onNotification(HGW_METHODS.session.focus, z.unknown(), () => undefined)
    .onConnect((connection) => {
      peer = connection.client
    })
  return {
    app,
    prompts,
    cancelled,
    resumed,
    push,
    busy,
    created,
    forked,
    unavailable,
    /** One question request, exactly as the gateway issues it. */
    ask: (sessionId: string, requestId: string) =>
      peer?.request(methods.client.elicitation.create, {
        mode: "form",
        sessionId,
        requestId,
        message: "The runtime needs an answer",
        requestedSchema: {
          type: "object",
          properties: { q0: { type: "string", enum: ["Yes", "No"] } },
        },
        _meta: {
          [HGW_META_KEY]: {
            requestId,
            questions: [
              {
                header: "Confirm",
                prompt: "Continue the migration?",
                options: [{ label: "Yes" }, { label: "No" }],
                multiple: false,
                custom: false,
              },
            ],
          },
        },
      }),
  }
}

const CONFIG = {
  status: "ready",
  mode: "aos",
  composerFeatures: { modelSelectorEnabled: true, contextEnabled: true },
} as const

/** A WebSocket-shaped pipe to the in-process gateway agent. */
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

function mount(options?: Parameters<typeof createGatewayAgent>[0]) {
  const gateway = createGatewayAgent(options)
  vi.stubGlobal("WebSocket", pipedSocket(gateway.app))
  let supplied: HarnessRuntime | undefined
  const Provider = runtimeAdapter.Provider
  render(
    <Provider config={CONFIG} locale="en">
      {(runtime) => {
        supplied = runtime
        return (
          <AssistantRuntimeProvider runtime={runtime.assistantRuntime}>
            <main>Workspace mounted</main>
            <Thread autoFocus={false} messageRewind={runtime.messageRewind} />
          </AssistantRuntimeProvider>
        )
      }}
    </Provider>
  )
  return { gateway, runtime: () => supplied }
}

/** Lets every queued notification and reply reach the runtime. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("provider-neutral AOS runtime composition", () => {
  it("resumes each opened Session once and replays nothing on return", async () => {
    const { gateway, runtime } = mount()
    await waitFor(() => expect(runtime()).toBeDefined())
    const supplied = runtime()!
    await supplied.assistantRuntime.threads.getLoadThreadsPromise()

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    expect(await screen.findByText("Ready")).toBeVisible()
    await settle()
    expect(gateway.resumed).toEqual([SESSION_ID])

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SECOND_SESSION_ID)
    })
    expect(await screen.findByText("First answer")).toBeVisible()
    await settle()
    expect(gateway.resumed).toEqual([SESSION_ID, SECOND_SESSION_ID])

    // The first Session's thread stays mounted and resumed while the operator
    // is away, so returning to it replays nothing: what arrived meanwhile is
    // already projected.
    act(() => {
      gateway.push(SESSION_ID, {
        sessionUpdate: "agent_message",
        messageId: "history-5",
        content: [{ type: "text", text: "Still here" }],
        _meta: { [HGW_META_KEY]: { turnId: "run-2", sequence: 1 } },
      })
    })
    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    expect(await screen.findByText("Still here")).toBeVisible()
    await settle()
    expect(gateway.resumed).toEqual([SESSION_ID, SECOND_SESSION_ID])
  })

  it("switching threads neither stops the provider run nor cancels a pending question", async () => {
    const { gateway, runtime } = mount()
    await waitFor(() => expect(runtime()).toBeDefined())
    const supplied = runtime()!
    await supplied.assistantRuntime.threads.getLoadThreadsPromise()
    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    await screen.findByText("Ready")

    act(() => {
      supplied.assistantRuntime.thread.composer.setText("Ship it")
      supplied.assistantRuntime.thread.composer.send()
    })
    await waitFor(() => expect(gateway.prompts).toHaveLength(1))
    act(() => {
      gateway.push(SESSION_ID, {
        sessionUpdate: "state_update",
        state: "running",
        _meta: { [HGW_META_KEY]: { turnId: "run-1", sequence: 3 } },
      })
    })
    await waitFor(() =>
      expect(supplied.assistantRuntime.thread.getState().isRunning).toBe(true)
    )

    let answered: unknown
    void gateway.ask(SESSION_ID, "interrupt-1")?.then((response) => {
      answered = response
    })
    await waitFor(() =>
      expect(supplied.interactions?.getPending(SESSION_ID)).toMatchObject({
        requestId: "interrupt-1",
      })
    )

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SECOND_SESSION_ID)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(answered).toBeUndefined()
    expect(gateway.cancelled).toEqual([])

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    expect(supplied.interactions?.getPending(SESSION_ID)).toMatchObject({
      requestId: "interrupt-1",
    })
  })

  it("forks a Session only where the gateway says it forks", async () => {
    const forking = mount({ forks: true })
    await waitFor(() => expect(forking.runtime()?.forkSession).toBeDefined())
    await expect(forking.runtime()!.forkSession!(SESSION_ID)).resolves.toEqual({
      sessionId: "forked-1",
    })
    expect(forking.gateway.forked).toEqual([SESSION_ID])
    cleanup()

    const plain = mount()
    await waitFor(() => expect(screen.getByRole("main")).toBeVisible())
    await act(async () => {
      await plain.runtime()!.assistantRuntime.threads.getLoadThreadsPromise()
    })
    expect(plain.runtime()?.forkSession).toBeUndefined()
  })

  it("starts a turn in a Session the active thread does not show, and rejects its refusal", async () => {
    const { gateway, runtime } = mount()
    await waitFor(() => expect(runtime()).toBeDefined())
    const supplied = runtime()!
    await supplied.assistantRuntime.threads.getLoadThreadsPromise()
    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    await screen.findByText("Ready")

    await act(() => supplied.startTurn!(SECOND_SESSION_ID, "Check the logs"))

    expect(gateway.prompts).toMatchObject([
      {
        sessionId: SECOND_SESSION_ID,
        prompt: [{ type: "text", text: "Check the logs" }],
        _meta: { [HGW_META_KEY]: { clientId: expect.any(String) } },
      },
    ])
    expect(supplied.assistantRuntime.threads.mainItem.getState().remoteId).toBe(
      SESSION_ID
    )
    expect(screen.queryByText("Check the logs")).toBeNull()

    gateway.busy.add(SECOND_SESSION_ID)
    await expect(
      supplied.startTurn!(SECOND_SESSION_ID, "Check again")
    ).rejects.toMatchObject({ code: HGW_JSONRPC_ERRORS.turnInProgress })
    expect(gateway.prompts).toHaveLength(1)
  })

  it("keeps a refused draft's turn in the composer and opens the next draft empty", async () => {
    const { gateway, runtime } = mount()
    await waitFor(() => expect(runtime()).toBeDefined())
    const thread = () => runtime()!.assistantRuntime.thread
    const send = async (text: string) => {
      await act(async () => {
        thread().composer.setText(text)
        thread().composer.send()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    await act(async () => {
      await runtime()!.createSessionDraft?.(AGENT_ID)
    })
    gateway.unavailable.creates = 1

    await send("Ship it")

    expect(
      await screen.findByText(en.runErrors.HGW_PROVIDER_UNAVAILABLE)
    ).toBeVisible()
    expect(thread().composer.getState().text).toBe("Ship it")
    expect(gateway.created).toEqual([])

    await act(async () => {
      await runtime()!.createSessionDraft?.(AGENT_ID)
    })

    expect(
      screen.queryByText(en.runErrors.HGW_PROVIDER_UNAVAILABLE)
    ).not.toBeInTheDocument()
    expect(thread().getState().messages).toEqual([])
    expect(thread().composer.getState().text).toBe("")

    await send("Ship it")
    await waitFor(() => expect(gateway.prompts).toHaveLength(1))
    expect(gateway.created).toEqual([AGENT_ID])
  })

  it("stages an attachment on a new Session's first message, before it is ever listed", async () => {
    // The catalog never lists `created-1`, so only its creation can name its
    // owner for the REST byte route.
    const stagePath = `/api/v1/agents/${AGENT_ID}/sessions/created-1/attachments/stage`
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === stagePath
        ? Response.json({
            stageId: "stage-1",
            attachments: [
              {
                type: "image",
                dataUrl: "data:image/png;base64,iVBORw0KGgo=",
                filename: "chart.png",
              },
            ],
          })
        : new Response(null, { status: 404 })
    )
    vi.stubGlobal("fetch", fetcher)
    const { gateway, runtime } = mount()
    await waitFor(() => expect(runtime()).toBeDefined())
    const composer = () => runtime()!.assistantRuntime.thread.composer
    await act(async () => {
      await runtime()!.createSessionDraft?.(AGENT_ID)
    })

    await act(async () => {
      await composer().addAttachment(
        new File(["png"], "chart.png", { type: "image/png" })
      )
      composer().setText("Read this chart")
      composer().send()
    })

    await waitFor(() => expect(gateway.prompts).toHaveLength(1))
    expect(fetcher).toHaveBeenCalledWith(
      stagePath,
      expect.objectContaining({ method: "POST" })
    )
    expect(gateway.prompts[0]).toMatchObject({
      sessionId: "created-1",
      _meta: { [HGW_META_KEY]: { attachmentStageId: "stage-1" } },
    })
    expect(screen.queryByText("Session ownership is unknown")).toBeNull()
  })
})

/** The operator workspace over the fake gateway, opened at one compact URL. */
function mountWorkspace(
  pathname: string,
  options?: Parameters<typeof createGatewayAgent>[0]
) {
  window.history.replaceState(null, "", pathname)
  const gateway = createGatewayAgent(options)
  vi.stubGlobal("WebSocket", pipedSocket(gateway.app))
  const Provider = runtimeAdapter.Provider
  const view = render(
    <Provider config={CONFIG} locale="en">
      {(runtime) => (
        <AosUiWorkspace
          runtime={runtime}
          locale="en"
          dictionary={en}
          now={new Date(UPDATED_AT)}
        />
      )}
    </Provider>
  )
  return { gateway, view }
}

describe("the workspace over one ACP connection", () => {
  it("renders the Session a URL names on a cold load", async () => {
    const { gateway } = mountWorkspace(`/${AGENT_ID}/${BOOKMARKED_SESSION_ID}`)

    // The Session sits past the first catalog page, so nothing has listed it
    // when the URL names it: the workspace opens that Session and no other
    // while the pages that describe it are still being read.
    expect(await screen.findByText("Bookmarked answer")).toBeVisible()
    expect(gateway.resumed).toEqual([BOOKMARKED_SESSION_ID])
    expect(screen.queryByText("Ready")).toBeNull()
    expect(window.location.pathname).toBe(
      `/${AGENT_ID}/${BOOKMARKED_SESSION_ID}`
    )
  })

  it("keeps the Session selected when Retry re-runs its first turn", async () => {
    const user = userEvent.setup()
    const { gateway } = mountWorkspace(`/${AGENT_ID}/${SECOND_SESSION_ID}`)
    expect(await screen.findByText("First answer")).toBeVisible()

    // Retry waits for the Session to report it can rewind.
    await user.click(
      await screen.findByRole("button", { name: "Retry response" })
    )

    await waitFor(() => expect(gateway.prompts).toHaveLength(1))
    expect(gateway.prompts[0]).toMatchObject({
      sessionId: SECOND_SESSION_ID,
      prompt: [{ type: "text", text: "Draft the plan" }],
    })
    expect(await screen.findByText("Shipping it")).toBeVisible()
    expect(window.location.pathname).toBe(`/${AGENT_ID}/${SECOND_SESSION_ID}`)
  })

  it("offers no Retry on a Session that cannot rewind", async () => {
    mountWorkspace(`/${AGENT_ID}/${SECOND_SESSION_ID}`, { rewind: false })
    expect(await screen.findByText("First answer")).toBeVisible()
    await settle()

    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Retry response" })).toBeNull()
  })

  it("keeps the transcript and reports a turn the provider refuses", async () => {
    const user = userEvent.setup()
    const { gateway } = mountWorkspace(`/${AGENT_ID}/${SECOND_SESSION_ID}`)
    expect(await screen.findByText("First answer")).toBeVisible()
    gateway.busy.add(SECOND_SESSION_ID)

    await user.click(
      await screen.findByRole("button", { name: "Retry response" })
    )

    expect(await screen.findByText(en.runErrors.HGW_SESSION_BUSY)).toBeVisible()
    expect(gateway.prompts).toHaveLength(0)
    expect(screen.getByText("Draft the plan")).toBeVisible()
    expect(screen.getByText("First answer")).toBeVisible()
    expect(window.location.pathname).toBe(`/${AGENT_ID}/${SECOND_SESSION_ID}`)
  })

  it("opens one ACP socket when React discards the provider's render", async () => {
    const gateway = createGatewayAgent()
    const sockets: { readyState: number }[] = []
    const socket = pipedSocket(gateway.app)
    vi.stubGlobal(
      "WebSocket",
      class extends socket {
        constructor() {
          super()
          sockets.push(this)
        }
      }
    )
    // The app renders the workspace behind `lazy`, so the provider's first
    // render suspends on its own child and React throws that render away.
    let loadWorkspace = () => {}
    const Workspace = lazy(
      () =>
        new Promise<{ default: () => ReactElement }>((resolve) => {
          loadWorkspace = () =>
            resolve({ default: () => <main>Workspace mounted</main> })
        })
    )
    const Provider = runtimeAdapter.Provider
    const view = render(
      <Suspense fallback={<span>Loading workspace</span>}>
        <Provider config={CONFIG} locale="en">
          {() => <Workspace />}
        </Provider>
      </Suspense>
    )
    expect(await screen.findByText("Loading workspace")).toBeVisible()
    act(() => loadWorkspace())
    expect(await screen.findByRole("main")).toHaveTextContent(
      "Workspace mounted"
    )

    expect(sockets).toHaveLength(1)

    view.unmount()
    await waitFor(() => expect(sockets[0]?.readyState).toBe(3))
  })
})
