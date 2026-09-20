import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentContext,
  type AnyWireMessage,
  type PromptRequest,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { lazy, Suspense, type ReactElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_META_KEY,
} from "@aos/protocol/acp"

import { AosUiWorkspace } from "../../components/aos-ui-workspace"
import { Thread } from "../../components/assistant-ui/elements/thread.aui"
import { en } from "../../lib/i18n/dictionaries/en"
import type { HarnessRuntime } from "../contracts"
import { runtimeAdapter } from "./composition"

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

const unavailable = { status: "unavailable", reason: "not-supported" } as const

/** The capability snapshot `session/resume` reports for the opened Session. */
function capabilities() {
  return {
    workspace: {
      slashCommands: unavailable,
      models: unavailable,
      context: unavailable,
      todos: unavailable,
      activity: unavailable,
    },
    interactions: {
      steering: unavailable,
      approvals: unavailable,
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

const sessionInfo = {
  agentId: AGENT_ID,
  status: "idle",
  archived: false,
  unread: false,
} as const

const configOptions: SessionConfigOption[] = []

/** One task of latency, which every pending replay settles ahead of. */
const catalogLatency = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

/** The AOS proxy end of the operator connection, in process. */
function createProxyAgent() {
  let peer: AgentContext | undefined
  const prompts: PromptParams[] = []
  const cancelled: string[] = []
  const resumed: string[] = []
  // The proxy keeps each Session's transcript and replays it from the start on
  // every such resume; it streams live updates only to an attached client.
  const history = new Map<string, SessionUpdate[]>()
  const attached = new Set<string>()
  const busy = new Set<string>()

  function push(sessionId: string, update: SessionUpdate) {
    history.set(sessionId, [...(history.get(sessionId) ?? []), update])
    if (attached.has(sessionId))
      void peer?.notify(methods.client.session.update, { sessionId, update })
  }

  history.set(SESSION_ID, [
    {
      sessionUpdate: "agent_message",
      messageId: "history-1",
      content: [{ type: "text", text: "Ready" }],
      _meta: { [AOS_META_KEY]: { runId: "run-0", sequence: 0 } },
    },
  ])

  history.set(BOOKMARKED_SESSION_ID, [
    {
      sessionUpdate: "agent_message",
      messageId: "history-4",
      content: [{ type: "text", text: "Bookmarked answer" }],
      _meta: { [AOS_META_KEY]: { runId: "run-0", sequence: 0 } },
    },
  ])

  history.set(SECOND_SESSION_ID, [
    {
      sessionUpdate: "user_message",
      messageId: "history-2",
      content: [{ type: "text", text: "Draft the plan" }],
      _meta: { [AOS_META_KEY]: { runId: "run-0", sequence: 0 } },
    },
    {
      sessionUpdate: "agent_message",
      messageId: "history-3",
      content: [{ type: "text", text: "First answer" }],
      _meta: { [AOS_META_KEY]: { runId: "run-0", sequence: 1 } },
    },
  ])

  const app = agent({ name: "fake-aos-proxy" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 2,
      info: { name: "aos-proxy", version: "1" },
      _meta: {
        [AOS_META_KEY]: {
          version: 1,
          lane: "operator",
          extensions: {
            steer: true,
            rewind: true,
            artifacts: true,
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
          _meta: { [AOS_META_KEY]: sessionInfo },
        })),
        ...(page + 1 < CATALOG_PAGES.length
          ? { nextCursor: String(page + 1) }
          : {}),
      }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      const { sessionId } = params
      resumed.push(sessionId)
      attached.add(sessionId)
      // The proxy replays inside the resume request, before answering it, so a
      // browser that waits for the response has already seen the history.
      if (params.replayFrom?.type === "start")
        for (const update of history.get(sessionId) ?? [])
          await peer?.notify(methods.client.session.update, {
            sessionId,
            update,
          })
      return {
        configOptions,
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
      // Exactly what the proxy refuses a prompt with while a Session is not idle.
      if (busy.has(params.sessionId))
        throw new RequestError(
          AOS_JSONRPC_ERRORS.runInProgress,
          "run_in_progress"
        )
      prompts.push(params)
      const messageId = `prompt-${prompts.length}`
      queueMicrotask(() => {
        push(params.sessionId, {
          sessionUpdate: "user_message",
          messageId,
          content: params.prompt,
          _meta: { [AOS_META_KEY]: { runId: "run-1", sequence: 1 } },
        })
        push(params.sessionId, {
          sessionUpdate: "agent_message",
          messageId: `answer-${prompts.length}`,
          content: [{ type: "text", text: "Shipping it" }],
          _meta: { [AOS_META_KEY]: { runId: "run-1", sequence: 2 } },
        })
      })
      return { _meta: { [AOS_META_KEY]: { messageId } } }
    })
    .onRequest(AOS_METHODS.agents.list, z.unknown().optional(), () => ({
      revision: "revision-1",
      agents: [
        {
          summary: { kind: "ready", id: AGENT_ID, name: "Researcher" },
          visibility: "visible",
          selectable: true,
          editable: true,
          revision: "revision-1",
        },
      ],
    }))
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      cancelled.push(params.sessionId)
    })
    .onNotification(AOS_METHODS.session.focus, z.unknown(), () => undefined)
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
    /** One question interrupt, exactly as the proxy issues it. */
    ask: (sessionId: string, interruptId: string) =>
      peer?.request(methods.client.elicitation.create, {
        mode: "form",
        sessionId,
        requestId: interruptId,
        message: "The runtime needs an answer",
        requestedSchema: {
          type: "object",
          properties: { q0: { type: "string", enum: ["Yes", "No"] } },
        },
        _meta: {
          [AOS_META_KEY]: {
            interruptId,
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

/** A WebSocket-shaped pipe to the in-process proxy agent. */
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

function mount() {
  const proxy = createProxyAgent()
  vi.stubGlobal("WebSocket", pipedSocket(proxy.app))
  let supplied: HarnessRuntime | undefined
  const Provider = runtimeAdapter.Provider
  render(
    <Provider
      config={{
        status: "ready",
        mode: "aos",
        composerFeatures: {
          modelSelectorEnabled: true,
          contextEnabled: true,
        },
      }}
      locale="en"
    >
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
  return { proxy, runtime: () => supplied }
}

const messageTexts = (runtime: HarnessRuntime) =>
  runtime.assistantRuntime.thread
    .getState()
    .messages.map((message) =>
      message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
    )

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
  it("mounts the workspace over one ACP connection and lists its Agents", async () => {
    const { runtime } = mount()

    expect(await screen.findByRole("main")).toHaveTextContent(
      "Workspace mounted"
    )
    await waitFor(() => expect(runtime()).toBeDefined())
    expect(await runtime()!.workspace.listAgents()).toMatchObject([
      { id: AGENT_ID, name: "Researcher" },
    ])
    expect(runtime()!.interactions).toBeDefined()
    expect(runtime()!.activityCoverage).toBe("workspace")
  })

  it("opens a listed Session and round-trips one prompt", async () => {
    const { proxy, runtime } = mount()
    await waitFor(() => expect(runtime()).toBeDefined())
    const supplied = runtime()!
    await supplied.assistantRuntime.threads.getLoadThreadsPromise()
    expect(supplied.assistantRuntime.threads.getState().threadIds).toEqual([
      SESSION_ID,
      SECOND_SESSION_ID,
    ])

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    expect(await screen.findByText("Ready")).toBeVisible()

    act(() => {
      supplied.assistantRuntime.thread.composer.setText("Ship it")
      supplied.assistantRuntime.thread.composer.send()
    })
    expect(await screen.findByText("Shipping it")).toBeVisible()
    await waitFor(() => expect(proxy.prompts).toHaveLength(1))
    expect(proxy.prompts[0]).toMatchObject({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "Ship it" }],
    })
    await waitFor(() =>
      expect(messageTexts(supplied)).toEqual([
        "Ready",
        "Ship it",
        "Shipping it",
      ])
    )
  })

  it("resumes each opened Session once and replays nothing on return", async () => {
    const { proxy, runtime } = mount()
    await waitFor(() => expect(runtime()).toBeDefined())
    const supplied = runtime()!
    await supplied.assistantRuntime.threads.getLoadThreadsPromise()

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    expect(await screen.findByText("Ready")).toBeVisible()
    await settle()
    expect(proxy.resumed).toEqual([SESSION_ID])

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SECOND_SESSION_ID)
    })
    expect(await screen.findByText("First answer")).toBeVisible()
    await settle()
    expect(proxy.resumed).toEqual([SESSION_ID, SECOND_SESSION_ID])

    // The first Session's thread stays mounted and attached while the operator
    // is away, so returning to it replays nothing: what arrived meanwhile is
    // already projected.
    act(() => {
      proxy.push(SESSION_ID, {
        sessionUpdate: "agent_message",
        messageId: "history-5",
        content: [{ type: "text", text: "Still here" }],
        _meta: { [AOS_META_KEY]: { runId: "run-2", sequence: 1 } },
      })
    })
    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    expect(await screen.findByText("Still here")).toBeVisible()
    await settle()
    expect(proxy.resumed).toEqual([SESSION_ID, SECOND_SESSION_ID])
  })

  it("switching threads does not stop the provider run", async () => {
    const { proxy, runtime } = mount()
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
    await waitFor(() => expect(proxy.prompts).toHaveLength(1))
    act(() => {
      proxy.push(SESSION_ID, {
        sessionUpdate: "state_update",
        state: "running",
        _meta: { [AOS_META_KEY]: { runId: "run-1", sequence: 3 } },
      })
    })
    await waitFor(() =>
      expect(supplied.assistantRuntime.thread.getState().isRunning).toBe(true)
    )

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SECOND_SESSION_ID)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(proxy.cancelled).toEqual([])
  })

  it("switching threads leaves a question pending instead of cancelling it", async () => {
    const { proxy, runtime } = mount()
    await waitFor(() => expect(runtime()).toBeDefined())
    const supplied = runtime()!
    await supplied.assistantRuntime.threads.getLoadThreadsPromise()
    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    await screen.findByText("Ready")

    let answered: unknown
    void proxy.ask(SESSION_ID, "interrupt-1")?.then((response) => {
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
    expect(proxy.cancelled).toEqual([])

    await act(async () => {
      await supplied.assistantRuntime.threads.switchToThread(SESSION_ID)
    })
    expect(supplied.interactions?.getPending(SESSION_ID)).toMatchObject({
      requestId: "interrupt-1",
    })
  })
})

/** The operator workspace over the fake proxy, opened at one compact URL. */
function mountWorkspace(pathname: string) {
  window.history.replaceState(null, "", pathname)
  const proxy = createProxyAgent()
  const sockets: unknown[] = []
  const socket = pipedSocket(proxy.app)
  vi.stubGlobal(
    "WebSocket",
    class extends socket {
      constructor() {
        super()
        sockets.push(this)
      }
    }
  )
  const Provider = runtimeAdapter.Provider
  const view = render(
    <Provider
      config={{
        status: "ready",
        mode: "aos",
        composerFeatures: { modelSelectorEnabled: true, contextEnabled: true },
      }}
      locale="en"
    >
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
  return { proxy, sockets, view }
}

describe("the workspace over one ACP connection", () => {
  it("renders the Session a URL names on a cold load", async () => {
    const { proxy } = mountWorkspace(`/${AGENT_ID}/${BOOKMARKED_SESSION_ID}`)

    // The Session sits past the first catalog page, so nothing has listed it
    // when the URL names it: the workspace opens that Session and no other
    // while the pages that describe it are still being read.
    expect(await screen.findByText("Bookmarked answer")).toBeVisible()
    expect(proxy.resumed).toEqual([BOOKMARKED_SESSION_ID])
    expect(screen.queryByText("Ready")).toBeNull()
    expect(window.location.pathname).toBe(
      `/${AGENT_ID}/${BOOKMARKED_SESSION_ID}`
    )
  })

  it("keeps the Session selected when Retry re-runs its first turn", async () => {
    const user = userEvent.setup()
    const { proxy } = mountWorkspace(`/${AGENT_ID}/${SECOND_SESSION_ID}`)
    expect(await screen.findByText("First answer")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Retry response" }))

    await waitFor(() => expect(proxy.prompts).toHaveLength(1))
    expect(proxy.prompts[0]).toMatchObject({
      sessionId: SECOND_SESSION_ID,
      prompt: [{ type: "text", text: "Draft the plan" }],
    })
    expect(await screen.findByText("Shipping it")).toBeVisible()
    expect(window.location.pathname).toBe(`/${AGENT_ID}/${SECOND_SESSION_ID}`)
  })

  it("keeps the transcript and reports a turn the provider refuses", async () => {
    const user = userEvent.setup()
    const { proxy } = mountWorkspace(`/${AGENT_ID}/${SECOND_SESSION_ID}`)
    expect(await screen.findByText("First answer")).toBeVisible()
    proxy.busy.add(SECOND_SESSION_ID)

    await user.click(screen.getByRole("button", { name: "Retry response" }))

    expect(await screen.findByText(en.runErrors.AOS_SESSION_BUSY)).toBeVisible()
    expect(proxy.prompts).toHaveLength(0)
    expect(screen.getByText("Draft the plan")).toBeVisible()
    expect(screen.getByText("First answer")).toBeVisible()
    expect(window.location.pathname).toBe(`/${AGENT_ID}/${SECOND_SESSION_ID}`)
  })

  it("opens one ACP socket when React discards the provider's render", async () => {
    const proxy = createProxyAgent()
    const sockets: { readyState: number }[] = []
    const socket = pipedSocket(proxy.app)
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
        <Provider
          config={{
            status: "ready",
            mode: "aos",
            composerFeatures: {
              modelSelectorEnabled: true,
              contextEnabled: true,
            },
          }}
          locale="en"
        >
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
