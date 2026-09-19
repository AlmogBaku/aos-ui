import {
  agent,
  methods,
  type AgentApp,
  type AgentContext,
  type AnyWireMessage,
  type PromptRequest,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { AOS_METHODS, AOS_META_KEY } from "@aos/protocol/acp"

import { Thread } from "../../components/assistant-ui/elements/thread.aui"
import type { HarnessRuntime } from "../contracts"
import { runtimeAdapter } from "./composition"

type PromptParams = PromptRequest

const AGENT_ID = "researcher"
const SESSION_ID = "session-1"
const SECOND_SESSION_ID = "session-2"
const UPDATED_AT = "2026-09-19T10:00:00.000Z"

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

/** The AOS proxy end of the operator connection, in process. */
function createProxyAgent() {
  let peer: AgentContext | undefined
  const prompts: PromptParams[] = []
  const cancelled: string[] = []
  // The proxy streams a Session only to a client attached to it, so updates
  // raised before an attach wait for the resume that replays them.
  const waiting = new Map<string, SessionUpdate[]>()
  const attached = new Set<string>()

  function push(sessionId: string, update: SessionUpdate) {
    if (attached.has(sessionId))
      void peer?.notify(methods.client.session.update, { sessionId, update })
    else waiting.set(sessionId, [...(waiting.get(sessionId) ?? []), update])
  }

  waiting.set(SESSION_ID, [
    {
      sessionUpdate: "agent_message",
      messageId: "history-1",
      content: [{ type: "text", text: "Ready" }],
      _meta: { [AOS_META_KEY]: { runId: "run-0", sequence: 0 } },
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
    .onRequest(methods.agent.session.list, () => ({
      sessions: [SESSION_ID, SECOND_SESSION_ID].map((sessionId) => ({
        sessionId,
        cwd: "/workspace",
        title: sessionId === SESSION_ID ? "Older" : "Newer",
        updatedAt: UPDATED_AT,
        _meta: { [AOS_META_KEY]: sessionInfo },
      })),
    }))
    .onRequest(methods.agent.session.resume, ({ params }) => {
      const { sessionId } = params
      queueMicrotask(() => {
        attached.add(sessionId)
        for (const update of waiting.get(sessionId) ?? [])
          void peer?.notify(methods.client.session.update, {
            sessionId,
            update,
          })
        waiting.delete(sessionId)
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
    push,
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
