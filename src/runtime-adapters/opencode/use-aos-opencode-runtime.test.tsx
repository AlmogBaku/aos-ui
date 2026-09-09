import {
  AssistantRuntimeProvider,
  type AssistantRuntime,
} from "@assistant-ui/react"
import type { OpencodeClient } from "@assistant-ui/react-opencode"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AosOpenCodeEventHub,
  useAosOpenCodeRuntime,
} from "./use-aos-opencode-runtime"
import { useOpenCodeRuntimeBundle } from "./use-opencode-runtime-bundle"
import type { OpenCodeRuntimeBundle } from "./use-opencode-runtime-bundle"
import { useOpenCodeComposerFeatures } from "./use-opencode-composer-features"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import { OpenCodeComposerFeatures } from "./composition"

afterEach(cleanup)

function nativeClient() {
  let emit!: (event: unknown) => void
  const nextEvent = new Promise<unknown>((resolve) => {
    emit = resolve
  })
  const session = {
    id: "session-build",
    title: "Build",
    agent: "build",
    model: { providerID: "native", id: "one" },
    time: { created: 0, updated: 0 },
  }
  const sessions = new Map([
    [session.id, session],
    [
      "session-review",
      {
        ...session,
        id: "session-review",
        title: "Review",
        model: { ...session.model },
      },
    ],
  ])
  const client = {
    provider: {
      list: vi.fn(async (): Promise<{ data: unknown }> => ({
        data: {
          connected: ["native"],
          all: [
            {
              id: "native",
              name: "Native",
              models: {
                one: {
                  id: "one",
                  providerID: "native",
                  name: "Model One",
                  limit: { context: 32768 },
                },
                two: {
                  id: "two",
                  providerID: "native",
                  name: "Model Two",
                  limit: { context: 65536 },
                },
              },
            },
          ],
        },
      })),
    },
    v2: {
      session: {
        switchModel: vi.fn(
          async ({
            sessionID,
            model,
          }: {
            sessionID: string
            model: { id: string; providerID: string }
          }) => {
            const current = sessions.get(sessionID)!
            current.model = model
            return { data: { data: current } }
          }
        ),
      },
    },
    event: {
      subscribe: vi.fn(async () => ({
        stream: (async function* () {
          yield await nextEvent
          yield await new Promise<never>(() => {})
        })(),
      })),
    },
    experimental: {
      session: { list: vi.fn(async () => ({ data: [...sessions.values()] })) },
    },
    session: {
      create: vi.fn(
        async (parameters: {
          agent?: string
          model?: { id: string; providerID: string }
        }) => {
          const created = {
            ...session,
            id: "session-created",
            agent: parameters.agent ?? "build",
            model: parameters.model ?? session.model,
          }
          sessions.set(created.id, created)
          return { data: created }
        }
      ),
      get: vi.fn(async ({ sessionID } = { sessionID: "session-build" }) => ({
        data: sessions.get(sessionID)!,
      })),
      messages: vi.fn(async () => ({ data: [] as unknown[] })),
      status: vi.fn(async () => ({ data: {} })),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      abort: vi.fn(async () => ({ data: true })),
      revert: vi.fn(async () => ({ data: session })),
    },
    permission: { list: vi.fn(async () => ({ data: [] })) },
    question: { list: vi.fn(async () => ({ data: [] })) },
  }
  return {
    client: client as unknown as OpencodeClient,
    native: client,
    sessions,
    emit,
  }
}

describe("AOS OpenCode runtime", () => {
  it("initializes new native Sessions with the configured default without changing existing Session models", async () => {
    const { client, native, sessions } = nativeClient()
    let bundle!: OpenCodeRuntimeBundle
    function Harness() {
      bundle = useOpenCodeRuntimeBundle({
        client,
        directory: "/external/worktree",
        initialSessionId: "session-build",
        defaultModel: { providerID: "native", modelID: "two" },
      })
      return <AssistantRuntimeProvider runtime={bundle.assistantRuntime} />
    }
    render(<Harness />)
    await act(async () => {
      await bundle.workspace.createSession("build")
    })
    expect(native.session.create).toHaveBeenCalledWith(
      { agent: "build", model: { providerID: "native", id: "two" } },
      { throwOnError: true }
    )
    expect(sessions.get("session-build")!.model.id).toBe("one")
  })

  it("makes the native file picker available on the Session composer", async () => {
    const { client } = nativeClient()
    const hub = new AosOpenCodeEventHub(client)
    let runtime!: AssistantRuntime
    function Harness() {
      runtime = useAosOpenCodeRuntime(
        client,
        { initialSessionId: "session-build" },
        hub
      )
      return <AssistantRuntimeProvider runtime={runtime} />
    }
    render(<Harness />)

    await waitFor(() => expect(runtime.thread.getState().isLoading).toBe(false))
    expect(runtime.thread.getState().capabilities.attachments).toBe(true)
    expect(runtime.thread.composer.getState().attachmentAccept).toContain(
      "application/pdf"
    )
  })

  it("edits the original Session with replacement text and existing files, then refreshes without retry replay", async () => {
    const { client, native } = nativeClient()
    const original = {
      info: {
        id: "user-original",
        sessionID: "session-build",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "native", modelID: "one" },
      },
      parts: [
        {
          id: "text-1",
          messageID: "user-original",
          sessionID: "session-build",
          type: "text",
          text: "Original prompt",
        },
        {
          id: "file-1",
          messageID: "user-original",
          sessionID: "session-build",
          type: "file",
          mime: "application/pdf",
          filename: "report.pdf",
          url: "data:application/pdf;base64,cGRm",
        },
      ],
    }
    native.session.messages.mockResolvedValue({ data: [original] })
    let runtime!: AssistantRuntime
    function Harness() {
      runtime = useOpenCodeRuntimeBundle({
        client,
        directory: "/external/worktree",
        initialSessionId: "session-build",
      }).assistantRuntime
      return <AssistantRuntimeProvider runtime={runtime} />
    }
    render(<Harness />)
    await waitFor(() =>
      expect(runtime.thread.getState().messages).toHaveLength(1)
    )

    const calls: string[] = []
    native.session.revert.mockImplementation(async () => {
      calls.push("revert")
      return { data: await native.session.get().then(({ data }) => data) }
    })
    native.session.promptAsync.mockImplementation(async () => {
      calls.push("prompt")
      return { data: undefined }
    })
    native.session.messages.mockImplementation(async () => {
      calls.push("refresh")
      return { data: [original] }
    })
    const composer = runtime.thread.getMessageById("user-original").composer
    act(() => composer.beginEdit())
    act(() => composer.setText("Replacement prompt"))
    await act(async () => composer.send())
    await waitFor(() => expect(calls).toEqual(["revert", "prompt", "refresh"]))
    expect(native.session.revert).toHaveBeenCalledWith(
      { sessionID: "session-build", messageID: "user-original" },
      { throwOnError: true }
    )
    expect(native.session.promptAsync).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionID: "session-build",
        agent: "build",
        parts: [
          { type: "text", text: "Replacement prompt" },
          {
            type: "file",
            mime: "application/pdf",
            filename: "report.pdf",
            url: "data:application/pdf;base64,cGRm",
          },
        ],
      }),
      { throwOnError: true }
    )
  })

  it.each(["ownership", "abort", "revert", "parked ownership"] as const)(
    "preserves queued messages when edit undo fails during %s",
    async (failureAt) => {
      const { client, native, emit } = nativeClient()
      native.session.status.mockResolvedValue({
        data: { "session-build": { type: "busy" } },
      })
      native.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              id: "user-original",
              sessionID: "session-build",
              role: "user",
              time: { created: 1 },
              agent: "build",
              model: { providerID: "native", modelID: "one" },
            },
            parts: [
              {
                id: "text-original",
                messageID: "user-original",
                sessionID: "session-build",
                type: "text",
                text: "Original prompt",
              },
            ],
          },
        ],
      })
      const onError = vi.fn()
      let runtime!: AssistantRuntime
      function Harness() {
        runtime = useOpenCodeRuntimeBundle({
          client,
          directory: "/external/worktree",
          initialSessionId: "session-build",
          onError,
        }).assistantRuntime
        return <AssistantRuntimeProvider runtime={runtime} />
      }
      render(<Harness />)
      await waitFor(() =>
        expect(runtime.thread.getState().isRunning).toBe(true)
      )
      await waitFor(() =>
        expect(
          runtime.thread
            .getState()
            .messages.some(({ id }) => id === "user-original")
        ).toBe(true)
      )
      act(() => runtime.thread.composer.setText("Keep this queued message"))
      act(() => runtime.thread.composer.send())
      await waitFor(() =>
        expect(runtime.thread.composer.getState().queue).toHaveLength(1)
      )
      const queued = runtime.thread.composer.getState().queue
      if (failureAt === "parked ownership") {
        native.session.abort.mockImplementation(async () => {
          native.session.status.mockResolvedValue({ data: {} })
          emit({
            type: "session.idle",
            properties: { sessionID: "session-build" },
          })
          return { data: true }
        })
        act(() => runtime.thread.cancelRun())
        await waitFor(() =>
          expect(runtime.thread.getState().isRunning).toBe(false)
        )
        expect(runtime.thread.composer.getState().queue).toEqual(queued)
      }
      const error = new Error(`${failureAt} failed`)
      if (failureAt === "ownership" || failureAt === "parked ownership")
        native.session.get.mockRejectedValue(error)
      else native.session[failureAt].mockRejectedValue(error)
      const composer = runtime.thread.getMessageById("user-original").composer
      act(() => composer.beginEdit())
      act(() => composer.setText("Replacement prompt"))
      act(() => composer.send())
      await waitFor(() => expect(onError).toHaveBeenCalledWith(error))
      expect(runtime.thread.composer.getState().queue).toEqual(queued)
      expect(native.session.promptAsync).not.toHaveBeenCalled()
      if (failureAt === "parked ownership") {
        expect(native.session.abort).toHaveBeenCalledOnce()
        expect(native.session.revert).not.toHaveBeenCalled()
      }
    }
  )

  it.each([true, false])(
    "holds queued input when abort emits idle during a pending edit undo (success=%s)",
    async (undoSucceeds) => {
      const { client, native, sessions, emit } = nativeClient()
      native.session.status.mockResolvedValue({
        data: { "session-build": { type: "busy" } },
      })
      native.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              id: "user-original",
              sessionID: "session-build",
              role: "user",
              time: { created: 1 },
              agent: "build",
              model: { providerID: "native", modelID: "one" },
            },
            parts: [
              {
                id: "text-original",
                messageID: "user-original",
                sessionID: "session-build",
                type: "text",
                text: "Original prompt",
              },
            ],
          },
        ],
      })
      const onError = vi.fn()
      let runtime!: AssistantRuntime
      function Harness() {
        runtime = useOpenCodeRuntimeBundle({
          client,
          directory: "/external/worktree",
          initialSessionId: "session-build",
          onError,
        }).assistantRuntime
        return <AssistantRuntimeProvider runtime={runtime} />
      }
      render(<Harness />)
      await waitFor(() =>
        expect(runtime.thread.getState().isRunning).toBe(true)
      )
      act(() => runtime.thread.composer.setText("Preserve queued input"))
      act(() => runtime.thread.composer.send())
      await waitFor(() =>
        expect(runtime.thread.composer.getState().queue).toHaveLength(1)
      )
      const queued = runtime.thread.composer.getState().queue
      let finishUndo!: () => void
      const undoFailure = new Error("Native undo failed")
      native.session.revert.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            finishUndo = () => {
              if (undoSucceeds)
                resolve({ data: sessions.get("session-build")! })
              else reject(undoFailure)
            }
          })
      )
      native.session.abort.mockImplementation(async () => {
        native.session.status.mockResolvedValue({ data: {} })
        emit({
          type: "session.idle",
          properties: { sessionID: "session-build" },
        })
        return { data: true }
      })
      const composer = runtime.thread.getMessageById("user-original").composer
      act(() => composer.beginEdit())
      act(() => composer.setText("Replacement prompt"))
      act(() => composer.send())
      await waitFor(() => expect(native.session.revert).toHaveBeenCalledOnce())
      await waitFor(() =>
        expect(runtime.thread.getState().isRunning).toBe(false)
      )
      expect(native.session.promptAsync).not.toHaveBeenCalled()
      expect(runtime.thread.composer.getState().queue).toEqual(queued)

      await act(async () => finishUndo())
      await waitFor(() =>
        expect(native.session.promptAsync).toHaveBeenCalledOnce()
      )
      expect(native.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionID: "session-build",
          parts: [
            {
              type: "text",
              text: undoSucceeds
                ? "Replacement prompt"
                : "Preserve queued input",
            },
          ],
        }),
        { throwOnError: true }
      )
      expect(runtime.thread.composer.getState().queue).toHaveLength(0)
      if (undoSucceeds) expect(onError).not.toHaveBeenCalled()
      else expect(onError).toHaveBeenCalledExactlyOnceWith(undoFailure)
    }
  )

  it.each([
    { promptFails: true, refreshFails: false },
    { promptFails: true, refreshFails: true },
    { promptFails: false, refreshFails: true },
  ])(
    "refreshes after an edited prompt failure and preserves the primary error ($promptFails/$refreshFails)",
    async ({ promptFails, refreshFails }) => {
      const { client, native, sessions } = nativeClient()
      native.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              id: "user-original",
              sessionID: "session-build",
              role: "user",
              time: { created: 1 },
              agent: "build",
              model: { providerID: "native", modelID: "one" },
            },
            parts: [
              {
                id: "text-original",
                messageID: "user-original",
                sessionID: "session-build",
                type: "text",
                text: "Original prompt",
              },
            ],
          },
        ],
      })
      const calls: string[] = []
      const onError = vi.fn(() => {
        calls.push("error")
      })
      let runtime!: AssistantRuntime
      function Harness() {
        runtime = useOpenCodeRuntimeBundle({
          client,
          directory: "/external/worktree",
          initialSessionId: "session-build",
          onError,
        }).assistantRuntime
        return <AssistantRuntimeProvider runtime={runtime} />
      }
      render(<Harness />)
      await waitFor(() =>
        expect(runtime.thread.getState().messages).toHaveLength(1)
      )
      const promptError = new Error("replacement prompt failed")
      const refreshError = new Error("authoritative refresh failed")
      native.session.revert.mockImplementation(async () => {
        calls.push("revert")
        return { data: sessions.get("session-build")! }
      })
      native.session.promptAsync.mockImplementation(async () => {
        calls.push("prompt")
        if (promptFails) throw promptError
        return { data: undefined }
      })
      native.session.messages.mockImplementation(async () => {
        calls.push("refresh")
        if (refreshFails) throw refreshError
        return { data: [] }
      })
      const composer = runtime.thread.getMessageById("user-original").composer
      act(() => composer.beginEdit())
      act(() => composer.setText("Replacement prompt"))
      act(() => composer.send())
      await waitFor(() =>
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          promptFails ? promptError : refreshError
        )
      )
      expect(calls).toEqual(["revert", "prompt", "refresh", "error"])
      if (!refreshFails)
        expect(
          runtime.thread
            .getState()
            .messages.some(({ id }) => id === "user-original")
        ).toBe(false)
    }
  )

  it("selects a native Session model and uses it for subsequent prompts even with a configured default", async () => {
    const { client, native } = nativeClient()
    const hub = new AosOpenCodeEventHub(client)
    let runtime!: AssistantRuntime
    let features!: ComposerFeatureViewModel
    function Features() {
      features = useOpenCodeComposerFeatures(client)
      return null
    }
    function Harness() {
      runtime = useAosOpenCodeRuntime(
        client,
        {
          initialSessionId: "session-build",
          defaultModel: { providerID: "native", modelID: "one" },
        },
        hub
      )
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <Features />
        </AssistantRuntimeProvider>
      )
    }
    render(<Harness />)
    await waitFor(() =>
      expect(features.model?.options.map(({ label }) => label)).toEqual([
        "Model One",
        "Model Two",
      ])
    )
    const selected = features.model!.options.find(
      ({ label }) => label === "Model Two"
    )!
    await act(async () => features.model!.select(selected.id))
    await waitFor(() => expect(features.model?.selectedId).toBe(selected.id))
    expect(native.v2.session.switchModel).toHaveBeenCalledExactlyOnceWith(
      {
        sessionID: "session-build",
        model: { providerID: "native", id: "two" },
      },
      { throwOnError: true }
    )
    act(() => runtime.thread.composer.setText("Use chosen model"))
    await act(async () => runtime.thread.composer.send())
    expect(native.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { providerID: "native", modelID: "two" },
      }),
      { throwOnError: true }
    )
  })

  it("builds ComposerContext usage from native tokens and gates features independently", async () => {
    const { client, native } = nativeClient()
    const hub = new AosOpenCodeEventHub(client)
    let features!: ComposerFeatureViewModel
    const assistant = {
      id: "assistant-1",
      sessionID: "session-build",
      role: "assistant",
      parentID: "user-1",
      time: { created: 2, completed: 3 },
      providerID: "native",
      modelID: "one",
      agent: "build",
      mode: "build",
      path: { cwd: "/external", root: "/external" },
      cost: 0,
      tokens: {
        total: 12345,
        input: 9000,
        output: 100,
        reasoning: 2,
        cache: { read: 3000, write: 0 },
      },
    }
    native.session.messages.mockResolvedValue({
      data: [
        {
          info: assistant,
          parts: [
            {
              id: "text-1",
              sessionID: "session-build",
              messageID: "assistant-1",
              type: "text",
              text: "a".repeat(4_000),
            },
          ],
        },
      ],
    })
    function Features({ config }: { config: ComposerFeatureConfig }) {
      features = useOpenCodeComposerFeatures(client, config)
      return null
    }
    function Harness({ config }: { config: ComposerFeatureConfig }) {
      const runtime = useAosOpenCodeRuntime(
        client,
        { initialSessionId: "session-build" },
        hub
      )
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <Features config={config} />
        </AssistantRuntimeProvider>
      )
    }
    const view = render(
      <Harness config={{ modelSelectorEnabled: false, contextEnabled: true }} />
    )
    await waitFor(() =>
      expect(features.context).toEqual({
        usage: { system: 0, tools: 0, messages: 12, total: 33 },
        segments: [],
      })
    )
    expect(features.model).toBeUndefined()
    view.rerender(
      <Harness config={{ modelSelectorEnabled: true, contextEnabled: false }} />
    )
    await waitFor(() => expect(features.model).toBeDefined())
    expect(features.context).toBeUndefined()
    view.rerender(
      <Harness config={{ modelSelectorEnabled: true, contextEnabled: true }} />
    )
    const tokens: Partial<typeof assistant.tokens> = { ...assistant.tokens }
    delete tokens.total
    act(() =>
      hub.emit({
        type: "message.updated",
        sessionId: "session-build",
        properties: { info: { ...assistant, tokens } },
        raw: {},
      })
    )
    await waitFor(() =>
      expect(features.context).toEqual({
        usage: { system: 0, tools: 0, messages: 12, total: 33 },
        segments: [],
      })
    )
  })

  it("keeps a pending model change scoped to its Session across navigation and native updates", async () => {
    const { client, native, sessions } = nativeClient()
    const hub = new AosOpenCodeEventHub(client)
    let features!: ComposerFeatureViewModel
    let runtime!: AssistantRuntime
    function Features() {
      features = useOpenCodeComposerFeatures(client)
      return null
    }
    function Harness() {
      runtime = useAosOpenCodeRuntime(
        client,
        { initialSessionId: "session-build" },
        hub
      )
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <Features />
        </AssistantRuntimeProvider>
      )
    }
    render(<Harness />)
    await waitFor(() => expect(features.model).toBeDefined())
    const one = features.model!.options.find(
      ({ label }) => label === "Model One"
    )!.id
    const two = features.model!.options.find(
      ({ label }) => label === "Model Two"
    )!.id
    let complete!: () => void
    const nativeSwitch = native.v2.session.switchModel.getMockImplementation()!
    native.v2.session.switchModel.mockImplementation(async (params) => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      return nativeSwitch(params)
    })
    let change!: Promise<void>
    act(() => {
      change = features.model!.select(two)
    })
    await act(async () => runtime.threads.switchToThread("session-review"))
    await waitFor(() =>
      expect(native.session.get).toHaveBeenCalledWith(
        { sessionID: "session-review" },
        { throwOnError: true }
      )
    )
    await act(async () => {
      complete()
      await change
    })
    expect(features.model!.selectedId).toBe(one)
    await act(async () => runtime.threads.switchToThread("session-build"))
    await waitFor(() => expect(features.model!.selectedId).toBe(two))
    const updated = {
      ...sessions.get("session-build")!,
      model: { id: "one", providerID: "native" },
    }
    act(() =>
      hub.emit({
        type: "session.updated",
        sessionId: "session-build",
        properties: { info: updated },
        raw: {},
      })
    )
    await waitFor(() => expect(features.model!.selectedId).toBe(one))
  })

  it.each(["switch", "refresh"] as const)(
    "reports model %s failures with Session identity and resolves the selection promise",
    async (failureAt) => {
      const { client, native } = nativeClient()
      const hub = new AosOpenCodeEventHub(client)
      const onError = vi.fn()
      let features!: ComposerFeatureViewModel
      function Features() {
        features = useOpenCodeComposerFeatures(client, undefined, onError)
        return null
      }
      function Harness() {
        const runtime = useAosOpenCodeRuntime(
          client,
          { initialSessionId: "session-build" },
          hub
        )
        return (
          <AssistantRuntimeProvider runtime={runtime}>
            <Features />
          </AssistantRuntimeProvider>
        )
      }
      render(<Harness />)
      await waitFor(() => expect(features.model).toBeDefined())
      const two = features.model!.options.find(
        ({ label }) => label === "Model Two"
      )!.id
      if (failureAt === "switch")
        native.v2.session.switchModel.mockRejectedValue(
          new Error("native switch failed")
        )
      else native.session.get.mockRejectedValue("native refresh failed")
      await act(async () => {
        await expect(features.model!.select(two)).resolves.toBeUndefined()
      })
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        "session-build"
      )
      expect(onError.mock.calls[0]?.[0].message).toBe(
        `native ${failureAt} failed`
      )
    }
  )

  it.each([
    {
      locale: "en",
      failureAt: "switch",
      title: "Model change failed",
      dismiss: "Dismiss notification",
      direction: "ltr",
    },
    {
      locale: "he",
      failureAt: "refresh",
      title: "שינוי המודל נכשל",
      dismiss: "סגירת הודעה",
      direction: "rtl",
    },
  ] as const)(
    "OpenCode composition shows localized dismissible feedback for $failureAt failure ($locale)",
    async ({ locale, failureAt, title, dismiss, direction }) => {
      const { client, native } = nativeClient()
      const hub = new AosOpenCodeEventHub(client)
      function Harness() {
        const runtime = useAosOpenCodeRuntime(
          client,
          { initialSessionId: "session-build" },
          hub
        )
        return (
          <AssistantRuntimeProvider runtime={runtime}>
            <OpenCodeComposerFeatures client={client} locale={locale}>
              {(features) =>
                features.model ? (
                  <button
                    onClick={() => {
                      const model = features.model!
                      const two = model.options.find(
                        ({ label }) => label === "Model Two"
                      )!
                      void model.select(two.id)
                    }}
                  >
                    Choose Model Two
                  </button>
                ) : null
              }
            </OpenCodeComposerFeatures>
          </AssistantRuntimeProvider>
        )
      }
      render(<Harness />)
      const choose = await screen.findByRole("button", {
        name: "Choose Model Two",
      })
      const error = new Error("model service unavailable")
      if (failureAt === "switch")
        native.v2.session.switchModel.mockRejectedValue({
          _tag: "InvalidRequestError",
          message: error.message,
        })
      else
        native.session.get.mockRejectedValue({
          name: "UnknownError",
          data: { message: error.message },
        })
      fireEvent.click(choose)
      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent(title)
      expect(alert).toHaveTextContent(error.message)
      expect(alert).toHaveAttribute("dir", direction)
      fireEvent.click(screen.getByRole("button", { name: dismiss }))
      expect(screen.queryByRole("alert")).toBeNull()
    }
  )

  it("OpenCode composition keeps late model failures with their originating Session", async () => {
    const { client, native } = nativeClient()
    const hub = new AosOpenCodeEventHub(client)
    let runtime!: AssistantRuntime
    let features!: ComposerFeatureViewModel
    function Harness() {
      runtime = useAosOpenCodeRuntime(
        client,
        { initialSessionId: "session-build" },
        hub
      )
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <OpenCodeComposerFeatures client={client} locale="en">
            {(value) => {
              features = value
              return null
            }}
          </OpenCodeComposerFeatures>
        </AssistantRuntimeProvider>
      )
    }
    render(<Harness />)
    await waitFor(() => expect(features.model).toBeDefined())
    const two = features.model!.options.find(
      ({ label }) => label === "Model Two"
    )!.id
    let failBuild!: (error: Error) => void
    native.v2.session.switchModel.mockImplementation(async ({ sessionID }) => {
      if (sessionID === "session-build")
        await new Promise<never>((_resolve, reject) => {
          failBuild = reject
        })
      throw new Error("Review model failed")
    })
    let pending!: Promise<void>
    await act(async () => {
      pending = features.model!.select(two)
    })
    await act(async () => runtime.threads.switchToThread("session-review"))
    await act(async () => {
      await features.model!.select(two)
    })
    expect(screen.getByRole("alert")).toHaveTextContent("Review model failed")
    await act(async () => {
      failBuild(new Error("Build model failed"))
      await expect(pending).resolves.toBeUndefined()
    })
    expect(screen.getByRole("alert")).toHaveTextContent("Review model failed")
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "Build model failed"
    )
    await act(async () => runtime.threads.switchToThread("session-build"))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Build model failed")
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" })
    )
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("orders rapid model choices within a Session while other Sessions remain independent", async () => {
    const { client, native, sessions } = nativeClient()
    const hub = new AosOpenCodeEventHub(client)
    let features!: ComposerFeatureViewModel
    let runtime!: AssistantRuntime
    function Features() {
      features = useOpenCodeComposerFeatures(client)
      return null
    }
    function Harness() {
      runtime = useAosOpenCodeRuntime(
        client,
        { initialSessionId: "session-build" },
        hub
      )
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <Features />
        </AssistantRuntimeProvider>
      )
    }
    render(<Harness />)
    await waitFor(() => expect(features.model).toBeDefined())
    const one = features.model!.options.find(
      ({ label }) => label === "Model One"
    )!.id
    const two = features.model!.options.find(
      ({ label }) => label === "Model Two"
    )!.id
    let releaseFirst!: () => void
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const nativeSwitch = native.v2.session.switchModel.getMockImplementation()!
    const calls: string[] = []
    native.v2.session.switchModel.mockImplementation(async (params) => {
      calls.push(`${params.sessionID}:${params.model.id}`)
      if (params.sessionID === "session-build" && params.model.id === "two")
        await firstResponse
      return nativeSwitch(params)
    })
    let first!: Promise<void>
    let last!: Promise<void>
    await act(async () => {
      first = features.model!.select(two)
      last = features.model!.select(one)
    })
    expect(calls).toEqual(["session-build:two"])
    await act(async () => runtime.threads.switchToThread("session-review"))
    await act(async () => features.model!.select(two))
    expect(calls).toEqual(["session-build:two", "session-review:two"])
    expect(features.model!.selectedId).toBe(two)
    await act(async () => {
      releaseFirst()
      await Promise.all([first, last])
    })
    expect(calls).toEqual([
      "session-build:two",
      "session-review:two",
      "session-build:one",
    ])
    expect(sessions.get("session-build")!.model.id).toBe("one")
    expect(features.model!.selectedId).toBe(two)
    await act(async () => runtime.threads.switchToThread("session-build"))
    await waitFor(() => expect(features.model!.selectedId).toBe(one))
  })

  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "omits context when native model capacity is unavailable or invalid (%s)",
    async (context) => {
      const { client, native } = nativeClient()
      native.provider.list.mockResolvedValue({
        data: {
          connected: ["native"],
          all: [
            {
              id: "native",
              name: "Native",
              models: {
                one: {
                  id: "one",
                  providerID: "native",
                  name: "Model One",
                  limit: { context },
                },
              },
            },
          ],
        },
      })
      native.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              id: "assistant-1",
              sessionID: "session-build",
              role: "assistant",
              time: { created: 1 },
              tokens: { total: 17 },
            },
            parts: [],
          },
        ],
      })
      const hub = new AosOpenCodeEventHub(client)
      let features!: ComposerFeatureViewModel
      function Features() {
        features = useOpenCodeComposerFeatures(client)
        return null
      }
      function Harness() {
        const runtime = useAosOpenCodeRuntime(
          client,
          { initialSessionId: "session-build" },
          hub
        )
        return (
          <AssistantRuntimeProvider runtime={runtime}>
            <Features />
          </AssistantRuntimeProvider>
        )
      }
      render(<Harness />)
      await waitFor(() => expect(features.model).toBeDefined())
      expect(features.context).toBeUndefined()
    }
  )
})
