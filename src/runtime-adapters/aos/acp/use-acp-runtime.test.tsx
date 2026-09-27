import {
  RequestError,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ExportedMessageRepository } from "@assistant-ui/core"
import type { CompleteAttachment } from "@assistant-ui/core"

import {
  AOS_ATTACHMENT_URI_SCHEME,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_PLAN_ID,
  AOS_STOP_REASONS,
  type AosHistoryCursor,
  type AosInitializeMeta,
} from "@aos/protocol/acp"

import { ARTIFACT_DATA_PART_NAME } from "@/artifacts/artifacts"
import { threadHistoryExtras } from "@/runtime-adapters/thread-history"

import { createAcpApprovals } from "./acp-approvals"
import type {
  AcpConnection,
  AcpPendingRequest,
  AcpHistoryPage,
  AcpSessionReplayListener,
  AcpSessionUpdateListener,
} from "./types"
import {
  acpExtras,
  useAcpRuntime,
  type UseAcpRuntimeOptions,
} from "./use-acp-runtime"

const SESSION_ID = "session-1"
const TURN_META = { sequence: 0, turnId: "run-1" }

/** The handshake of a proxy that does, or does not, serve older pages. */
const initializeMeta = (historyPages: boolean): AosInitializeMeta => ({
  version: 1,
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
    historyPages,
  },
})

function createFakeConnection(
  options: {
    /** What each from-start replay reports as `_meta.aos.history`. */
    history?: AosHistoryCursor
    historyPages?: boolean
  } = {}
) {
  const updates = new Map<string, Set<AcpSessionUpdateListener>>()
  const replays = new Map<string, Set<AcpSessionReplayListener>>()
  const notifications = new Map<string, Set<(params: unknown) => void>>()
  const pendingListeners = new Set<(pending: AcpPendingRequest) => void>()
  function listen<Listener>(
    keyed: Map<string, Set<Listener>>,
    sessionId: string,
    listener: Listener
  ) {
    const listeners = keyed.get(sessionId) ?? new Set()
    listeners.add(listener)
    keyed.set(sessionId, listeners)
    return () => listeners.delete(listener)
  }
  const unused = (): never => {
    throw new Error("The ACP runtime does not use this connection method")
  }
  let settle = () => {}
  const resumed = new Promise<void>((resolve) => {
    settle = resolve
  })
  /** What a from-start replay resends, while the resume is still in flight. */
  let replayedTurns: readonly SessionUpdate[] = []
  const fake = { history: options.history }
  const histories = new Map<string, AosHistoryCursor>()
  /** A from-start replay: announced, recorded, then settled, as the connection does. */
  const replayFromStart = async (sessionId: string, reply: Promise<void>) => {
    const settles = [...(replays.get(sessionId) ?? [])].map((listener) =>
      listener()
    )
    for (const update of replayedTurns)
      for (const listener of updates.get(sessionId) ?? [])
        listener(update, TURN_META)
    let replayed = false
    try {
      await reply
      if (fake.history) histories.set(sessionId, { ...fake.history })
      replayed = true
    } finally {
      for (const settle of settles) settle?.(replayed)
    }
  }
  // As the connection does: a from-start replay announces itself, so whoever
  // projects the Session drops what the replay is about to resend.
  const replay = vi.fn((sessionId: string) =>
    replayFromStart(sessionId, resumed)
  )
  const pages: PromiseWithResolvers<AcpHistoryPage>[] = []
  const resumePage = vi.fn<AcpConnection["resumePage"]>(() => {
    const page = Promise.withResolvers<AcpHistoryPage>()
    pages.push(page)
    return page.promise
  })
  const prompt = vi.fn(async () => ({ messageId: "u1" }))
  const cancel = vi.fn()

  const connection: AcpConnection = {
    status: "ready",
    // Already connected: nothing here owns a transport to open.
    start: () => {},
    initialized: Promise.resolve(initializeMeta(options.historyPages ?? true)),
    subscribeStatus: () => () => {},
    outage: undefined,
    subscribeOutage: () => () => {},
    login: unused,
    newSession: unused,
    listSessions: unused,
    subscribe: (sessionId, listener) => {
      const offs = [
        listener.update && listen(updates, sessionId, listener.update),
        listener.replay && listen(replays, sessionId, listener.replay),
      ]
      return () => {
        for (const off of offs) off?.()
      }
    },
    joined: unused,
    replay,
    sessionState: () => "joined",
    resumePage,
    history: (sessionId) => histories.get(sessionId),
    prompt,
    cancel,
    setConfigOption: unused,
    deleteSession: unused,
    updateSession: unused,
    steer: unused,
    focus: unused,
    listAgents: unused,
    updateAgent: unused,
    subscribeNotification: (method, listener) => {
      const listeners = notifications.get(method) ?? new Set()
      listeners.add(listener)
      notifications.set(method, listeners)
      return () => listeners.delete(listener)
    },
    subscribePendingRequests: (listener) => {
      pendingListeners.add(listener)
      return () => pendingListeners.delete(listener)
    },
    close: () => {},
  }

  return {
    connection,
    replay,
    resumePage,
    prompt,
    cancel,
    /** Stores the turns a later from-start replay resends. */
    replayOnResume: (turns: readonly SessionUpdate[]) => {
      replayedTurns = turns
    },
    /** The history the next from-start replay reports. */
    set history(history: AosHistoryCursor | undefined) {
      fake.history = history
    },
    /** Answers the `index`th page read. */
    answerPage: (index: number, page: AcpHistoryPage) => {
      pages[index]?.resolve(page)
    },
    failPage: (index: number) => {
      pages[index]?.reject(new Error("page read failed"))
    },
    /** A resync the connection runs on its own: a from-start replay. */
    resync: (reply = Promise.resolve()) => replayFromStart(SESSION_ID, reply),
    settleResume: () => {
      settle()
      return resumed
    },
    emit: (
      update: SessionUpdate,
      meta: Record<string, unknown> = TURN_META
    ) => {
      for (const listener of updates.get(SESSION_ID) ?? [])
        listener(update, meta)
    },
    notify: (method: string, params: unknown) => {
      for (const listener of notifications.get(method) ?? []) listener(params)
    },
    /** The proxy asks to run the call `toolCallId` names. */
    requestPermission: (toolCallId: string) => {
      const respond = vi.fn<(response: RequestPermissionResponse) => void>()
      const pending: AcpPendingRequest = {
        kind: "permission",
        sessionId: SESSION_ID,
        request: {
          sessionId: SESSION_ID,
          title: "Run bash",
          subject: { type: "tool_call", toolCall: { toolCallId } },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
          _meta: { aos: { requestId: "interrupt-1" } },
        },
        respond,
        signal: new AbortController().signal,
      }
      for (const listener of pendingListeners) listener(pending)
      return respond
    },
  }
}

type Fake = ReturnType<typeof createFakeConnection>

const textUpdate = (
  sessionUpdate: "user_message" | "agent_message",
  messageId: string,
  text: string
): SessionUpdate => ({
  sessionUpdate,
  messageId,
  content: [{ type: "text", text }],
})

/** A streamed part, which a transcript the replay did not drop would double. */
const chunkUpdate = (messageId: string, text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text },
})

const messageText = (part: { type: string }) =>
  part.type === "text" && "text" in part ? String(part.text) : ""

async function mount(
  fake: Fake,
  options?: Pick<
    UseAcpRuntimeOptions,
    | "approvals"
    | "subscribeSession"
    | "enableMessageQueue"
    | "onComposerPrefill"
    | "stageAttachments"
  >
) {
  const hook = renderHook(() =>
    useAcpRuntime({
      connection: fake.connection,
      sessionId: SESSION_ID,
      agentId: "agent-1",
      messageRewind: (sourceUserId) => ({
        rewindSourceId: `provider-${sourceUserId}`,
      }),
      ...options,
    })
  )
  await act(async () => {
    await fake.settleResume()
  })
  return hook
}

const visible = (runtime: ReturnType<typeof useAcpRuntime>) =>
  runtime.thread.getState().messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content.map(messageText).join(""),
  }))

describe("useAcpRuntime", () => {
  it("replays the Session on mount and projects its turns", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    expect(fake.replay).toHaveBeenCalledWith(SESSION_ID)
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
      fake.emit(textUpdate("agent_message", "a1", "On it"))
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
      { id: "a1", role: "assistant", text: "On it" },
    ])
  })

  it("tells its listeners once for a replay, however many updates it carries", async () => {
    const fake = createFakeConnection()
    const onStateChange = vi.fn()
    const { result } = renderHook(() =>
      useAcpRuntime({
        connection: fake.connection,
        sessionId: SESSION_ID,
        agentId: "agent-1",
        onStateChange,
      })
    )
    // The replay's updates answer the resume, so they land while it is in
    // flight. A stored Session sends one per part, and the reader only ever sees
    // the transcript whole.
    await act(async () => {})
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
      fake.emit(chunkUpdate("a1", "Working"))
      fake.emit(chunkUpdate("a1", " on it"))
    })
    expect(onStateChange).not.toHaveBeenCalled()
    await act(async () => {
      await fake.settleResume()
    })
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
      { id: "a1", role: "assistant", text: "Working on it" },
    ])
    // Once the replay is over, a live update is told as it lands.
    act(() => {
      fake.emit(chunkUpdate("a1", " now"))
    })
    expect(onStateChange).toHaveBeenCalledTimes(2)
  })

  it("keeps the transcript in view until a resync's replay settles, and after a refused or dropped one, gone if reported so", async () => {
    const fake = createFakeConnection()
    const { result, rerender } = renderHook(
      ({ isDisabled }: { isDisabled: boolean }) =>
        useAcpRuntime({
          connection: fake.connection,
          sessionId: SESSION_ID,
          agentId: "agent-1",
          isDisabled,
        }),
      { initialProps: { isDisabled: false } }
    )
    await act(async () => {
      await fake.settleResume()
    })
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
      fake.emit(chunkUpdate("a1", "On it"))
    })
    const prior = visible(result.current)

    await act(() =>
      fake.resync(Promise.reject(new Error("refused"))).catch(() => {})
    )
    expect(visible(result.current)).toEqual(prior)
    // The socket drops after the replay resent only its first turn.
    fake.replayOnResume([textUpdate("user_message", "u1", "Ship it")])
    await act(() =>
      fake.resync(Promise.reject(new Error("dropped"))).catch(() => {})
    )
    expect(visible(result.current)).toEqual(prior)

    fake.replayOnResume([
      textUpdate("user_message", "u1", "Ship it"),
      chunkUpdate("a1", "Shipped"),
    ])
    const reply = Promise.withResolvers<void>()
    let replayed = Promise.resolve()
    act(() => {
      replayed = fake.resync(reply.promise)
    })
    // A re-render mid-replay reads the transcript the reader was last told.
    rerender({ isDisabled: true })
    expect(visible(result.current)).toEqual(prior)

    await act(async () => {
      reply.resolve()
      await replayed
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
      { id: "a1", role: "assistant", text: "Shipped" },
    ])

    // The proxy reports the Session gone before a replay's drop: the restored
    // transcript still reads as gone.
    const shipped = visible(result.current)
    fake.replayOnResume([textUpdate("user_message", "u1", "Ship it")])
    const dropped = Promise.withResolvers<void>()
    let partway = Promise.resolve()
    act(() => {
      partway = fake.resync(dropped.promise).catch(() => {})
    })
    await act(async () => {
      fake.notify(AOS_METHODS.notify.error, {
        sessionId: SESSION_ID,
        code: "not_found",
        message: "not_found",
      })
      dropped.reject(new Error("dropped"))
      await partway
    })
    expect(visible(result.current)).toEqual(shipped)
    expect(result.current.thread.getState().messages.at(-1)?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: { code: "not_found" },
    })
  })

  it("keeps the turns an update leaves alone, so only the changed one re-renders", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
      fake.emit(chunkUpdate("a1", "Working"))
    })
    const [user, assistant] = result.current.thread.getState().messages
    act(() => {
      fake.emit(chunkUpdate("a1", " on it"))
    })
    const [nextUser, nextAssistant] = result.current.thread.getState().messages
    expect(nextUser).toBe(user)
    expect(nextAssistant).not.toBe(assistant)
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
      { id: "a1", role: "assistant", text: "Working on it" },
    ])
  })

  it("converts only the streaming turn per chunk, however long the transcript", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      for (let turn = 0; turn < 200; turn++) {
        fake.emit(textUpdate("user_message", `u${turn}`, `Question ${turn}`))
        fake.emit(chunkUpdate(`a${turn}`, `Answer ${turn}`))
      }
    })
    const before = result.current.thread.getState().messages
    const convert = vi.spyOn(ExportedMessageRepository, "fromArray")
    act(() => {
      fake.emit(chunkUpdate("a199", " and more"))
    })
    const after = result.current.thread.getState().messages
    expect(convert.mock.calls.flatMap(([messages]) => messages)).toHaveLength(1)
    expect(
      after.slice(0, -1).every((message, at) => message === before[at])
    ).toBe(true)
    expect(after.at(-1)).not.toBe(before.at(-1))
    convert.mockRestore()
  })

  it("resumes the opened Session once, whatever its caller's callbacks do", async () => {
    const fake = createFakeConnection()
    // The workspace closes these over the `AssistantClient`, which a
    // thread-list switch replaces, so it hands over new ones mid-thread.
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) =>
        useAcpRuntime({
          connection: fake.connection,
          sessionId: SESSION_ID,
          agentId: "agent-1",
          resolveSessionId: async () => `${SESSION_ID}-${nonce}`,
          stageAttachments: async () => ({
            stageId: `stage-${nonce}`,
            attachments: [],
          }),
        }),
      { initialProps: { nonce: 0 } }
    )
    await act(async () => {
      await fake.settleResume()
    })
    expect(fake.replay).toHaveBeenCalledTimes(1)

    await act(async () => {
      rerender({ nonce: 1 })
    })
    expect(fake.replay).toHaveBeenCalledTimes(1)
  })

  it("resumes again once the thread remounts, so a reopened Session replays", async () => {
    const fake = createFakeConnection()
    const first = await mount(fake)
    expect(fake.replay).toHaveBeenCalledTimes(1)

    first.unmount()
    await mount(fake)
    expect(fake.replay).toHaveBeenCalledTimes(2)
  })

  it("holds the caller's projection of the Session for as long as the thread binds it", async () => {
    const fake = createFakeConnection()
    const release = vi.fn()
    const subscribeSession = vi.fn(() => release)
    const { unmount } = await mount(fake, { subscribeSession })
    expect(subscribeSession).toHaveBeenCalledWith(SESSION_ID)
    expect(release).not.toHaveBeenCalled()

    unmount()
    expect(release).toHaveBeenCalledOnce()
  })

  it("stops waiting for a Session its provider has gone from", async () => {
    const fake = createFakeConnection()
    fake.replay.mockRejectedValue(RequestError.resourceNotFound())
    const { result } = renderHook(() =>
      useAcpRuntime({
        connection: fake.connection,
        sessionId: SESSION_ID,
        agentId: "agent-1",
      })
    )
    await act(async () => {})
    expect(result.current.thread.getState().isLoading).toBe(false)
    // The thread does not retry a refused resume: the connection's per-Session
    // owner retries unavailable; gone is terminal.
    expect(fake.replay).toHaveBeenCalledTimes(1)
  })

  it("replays the Session again when the proxy invalidates it", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit(chunkUpdate("a1", "On it"))
    })

    await act(async () => {
      fake.notify(AOS_METHODS.notify.sessionInvalidated, {
        sessionId: "other-session",
      })
    })
    expect(fake.replay).toHaveBeenCalledTimes(1)

    await act(async () => {
      fake.notify(AOS_METHODS.notify.sessionInvalidated, {
        sessionId: SESSION_ID,
      })
    })
    expect(fake.replay).toHaveBeenCalledTimes(2)
    expect(fake.replay).toHaveBeenLastCalledWith(SESSION_ID)
    // The replay rebuilds the transcript it dropped, rather than doubling it.
    act(() => {
      fake.emit(chunkUpdate("a1", "On it"))
    })
    expect(visible(result.current)).toEqual([
      { id: "a1", role: "assistant", text: "On it" },
    ])
  })

  it("ends the run of a Session the proxy reports gone", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit({ sessionUpdate: "state_update", state: "running" })
      fake.emit(chunkUpdate("a1", "Live"))
    })
    const gone = (sessionId: string) =>
      act(async () => {
        fake.notify(AOS_METHODS.notify.error, {
          sessionId,
          code: "not_found",
          message: "not_found",
        })
      })

    await gone("other-session")
    expect(result.current.thread.getState().isRunning).toBe(true)
    await gone(SESSION_ID)
    expect(result.current.thread.getState().isRunning).toBe(false)
    expect(result.current.thread.getState().messages[0]?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: { code: "not_found" },
    })
  })

  it("tracks the run state the Session reports", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    expect(result.current.thread.getState().isRunning).toBe(true)
    act(() => {
      fake.emit({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      })
    })
    expect(result.current.thread.getState().isRunning).toBe(false)
  })

  it("prompts with the user's blocks and re-keys the optimistic turn", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Ship it" }],
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Ship it" }],
        expect.objectContaining({})
      )
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
    ])
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
    ])
  })

  it("rewinds the source turn before a retry re-sends it", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
      fake.emit(textUpdate("agent_message", "a1", "Wrong answer"))
    })
    await act(async () => {
      result.current.thread.startRun({ parentId: "u1" })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Ship it" }],
        expect.objectContaining({ rewindSourceId: "provider-u1" })
      )
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
    ])
  })

  it("retries a turn of images alone as the rewind of its source", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [
          {
            type: "resource_link",
            uri: "aos-attachment:stage-1/att-1",
            name: "photo.png",
            mimeType: "image/png",
          },
        ],
      })
      fake.emit(textUpdate("agent_message", "a1", "Stopped"))
    })
    await act(async () => {
      result.current.thread.startRun({ parentId: "u1" })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [],
        expect.objectContaining({ rewindSourceId: "provider-u1" })
      )
    })
  })

  it("cancels the Session's run", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "Working"))
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    await act(async () => {
      result.current.thread.cancelRun()
    })
    expect(fake.cancel).toHaveBeenCalledWith(SESSION_ID)
  })

  it("keeps a prompt stopped before any reply, since the provider saved it", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Ship it" }],
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalled()
    })
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    await act(async () => {
      result.current.thread.cancelRun()
    })
    act(() => {
      fake.emit({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
      })
    })
    expect(fake.cancel).toHaveBeenCalledWith(SESSION_ID)
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
    ])
    expect(result.current.thread.composer.getState().text).toBe("")
  })

  describe("a run that fails before it writes a reply", () => {
    const HISTORY = [
      textUpdate("user_message", "u1", "Ship it"),
      textUpdate("agent_message", "a1", "On it"),
    ]
    const FAILURE = { code: "AOS_PROVIDER_RUN_FAILED", message: "Broke" }

    /** A thread holding the history the provider saved, and replays again. */
    async function mountWithHistory() {
      const fake = createFakeConnection()
      const hook = await mount(fake)
      act(() => {
        for (const update of HISTORY) fake.emit(update)
      })
      fake.replayOnResume(HISTORY)
      fake.prompt.mockResolvedValueOnce({ messageId: "u2" })
      return { fake, result: hook.result }
    }

    const fail = async (fake: Fake) => {
      await act(async () => {
        fake.emit({ sessionUpdate: "state_update", state: "running" })
        fake.emit(
          {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: AOS_STOP_REASONS.error,
          },
          { ...TURN_META, ...FAILURE }
        )
      })
    }

    const statusOf = (
      runtime: ReturnType<typeof useAcpRuntime>,
      index: number
    ) => runtime.thread.getState().messages[index]?.status

    it("reloads the Session and keeps the failure in view", async () => {
      const { fake, result } = await mountWithHistory()
      await act(async () => {
        result.current.thread.append({
          role: "user",
          content: [{ type: "text", text: "Again" }],
        })
      })
      await waitFor(() => {
        expect(fake.prompt).toHaveBeenCalled()
      })
      await fail(fake)
      // The provider never saved the prompt, so the reloaded thread drops it.
      await waitFor(() => {
        expect(fake.replay).toHaveBeenCalledTimes(2)
      })
      await waitFor(() => {
        expect(statusOf(result.current, 1)).toEqual({
          type: "incomplete",
          reason: "error",
          error: FAILURE,
        })
      })
      expect(visible(result.current)).toEqual([
        { id: "u1", role: "user", text: "Ship it" },
        { id: "a1", role: "assistant", text: "On it" },
      ])
    })

    it("brings back the turns a failed edit replaced", async () => {
      const { fake, result } = await mountWithHistory()
      await act(async () => {
        result.current.thread.append({
          role: "user",
          content: [{ type: "text", text: "Ship it now" }],
          parentId: null,
          sourceId: "u1",
        })
      })
      await waitFor(() => {
        expect(fake.prompt).toHaveBeenCalledWith(
          SESSION_ID,
          [{ type: "text", text: "Ship it now" }],
          expect.objectContaining({ rewindSourceId: "provider-u1" })
        )
      })
      await fail(fake)
      await waitFor(() => {
        expect(visible(result.current)).toEqual([
          { id: "u1", role: "user", text: "Ship it" },
          { id: "a1", role: "assistant", text: "On it" },
        ])
      })
      expect(statusOf(result.current, 1)).toEqual({
        type: "incomplete",
        reason: "error",
        error: FAILURE,
      })
    })

    it("does not reload a failure the replay itself restates", async () => {
      const fake = createFakeConnection()
      fake.replayOnResume([
        ...HISTORY,
        { sessionUpdate: "state_update", state: "running" },
        {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: AOS_STOP_REASONS.error,
        },
      ])
      await mount(fake)
      await act(async () => {})
      expect(fake.replay).toHaveBeenCalledTimes(1)
    })

    it("does not reload an uncertain state restated after the replay", async () => {
      const { fake } = await mountWithHistory()
      await act(async () => {
        fake.emit(
          {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: AOS_STOP_REASONS.uncertain,
          },
          TURN_META
        )
      })
      await act(async () => {})
      expect(fake.replay).toHaveBeenCalledTimes(1)
    })

    it("does not reload a failure its reply already shows", async () => {
      const { fake, result } = await mountWithHistory()
      await act(async () => {
        fake.emit({ sessionUpdate: "state_update", state: "running" })
        fake.emit(chunkUpdate("a2", "Half"))
        fake.emit(
          {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: AOS_STOP_REASONS.error,
          },
          { ...TURN_META, ...FAILURE }
        )
      })
      expect(fake.replay).toHaveBeenCalledTimes(1)
      expect(statusOf(result.current, 2)).toEqual({
        type: "incomplete",
        reason: "error",
        error: FAILURE,
      })
    })
  })

  it("creates the Session a draft's first turn needs, then prompts it", async () => {
    const fake = createFakeConnection()
    const subscribeSession = vi.fn(() => () => undefined)
    const resolveSessionId = vi.fn(async () => SESSION_ID)
    const { result } = renderHook(() =>
      useAcpRuntime({
        connection: fake.connection,
        sessionId: undefined,
        agentId: "agent-1",
        subscribeSession,
        resolveSessionId,
      })
    )
    expect(subscribeSession).not.toHaveBeenCalled()
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Ship it" }],
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Ship it" }],
        expect.objectContaining({})
      )
    })
    expect(resolveSessionId).toHaveBeenCalledTimes(1)
    // Binding the resolved Session is what holds, subscribes to, and replays it.
    expect(subscribeSession).toHaveBeenCalledWith(SESSION_ID)
    await act(async () => {
      await fake.settleResume()
    })
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "Shipping it"))
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
      { id: "a1", role: "assistant", text: "Shipping it" },
    ])
  })

  it("stages a turn's attachments and links the batch it staged", async () => {
    const fake = createFakeConnection()
    const stageAttachments = vi.fn(async () => ({
      stageId: "stage-1",
      attachments: [
        { id: "att-1", name: "chart.png", contentType: "image/png" },
      ],
    }))
    const { result } = await mount(fake, { stageAttachments })
    const attachment: CompleteAttachment = {
      id: "att-1",
      type: "image",
      name: "chart.png",
      contentType: "image/png",
      status: { type: "complete" },
      content: [{ type: "image", image: "data:image/png;base64,AAA" }],
    }
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Read this" }],
        attachments: [attachment],
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [
          { type: "text", text: "Read this" },
          {
            type: "resource_link",
            uri: `${AOS_ATTACHMENT_URI_SCHEME}stage-1/att-1`,
            name: "chart.png",
            mimeType: "image/png",
          },
        ],
        expect.objectContaining({ attachmentStageId: "stage-1" })
      )
    })
    expect(stageAttachments).toHaveBeenCalledWith(SESSION_ID, [attachment])
  })

  it("reports a composer prefill for the bound Session only", async () => {
    const fake = createFakeConnection()
    const onComposerPrefill = vi.fn()
    await mount(fake, { onComposerPrefill })
    act(() => {
      fake.notify(AOS_METHODS.notify.composerPrefill, {
        sessionId: "other-session",
        turnId: "run-1",
        text: "Elsewhere",
      })
    })
    expect(onComposerPrefill).not.toHaveBeenCalled()
    act(() => {
      fake.notify(AOS_METHODS.notify.composerPrefill, {
        sessionId: SESSION_ID,
        turnId: "run-1",
        text: "Next question?",
      })
    })
    expect(onComposerPrefill).toHaveBeenCalledWith("Next question?")
  })

  it("projects a published artifact link as an artifact part", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "On it"))
      fake.emit({
        sessionUpdate: "agent_message_chunk",
        messageId: "a1",
        content: {
          type: "resource_link",
          uri: "artifact://art-1",
          name: "chart.json",
          mimeType: "application/json",
        },
      })
    })
    expect(result.current.thread.getState().messages[0]?.content).toEqual([
      { type: "text", text: "On it" },
      {
        type: "data",
        name: ARTIFACT_DATA_PART_NAME,
        data: {
          id: "art-1",
          filename: "chart.json",
          mimeType: "application/json",
          source: { type: "provider", reference: "art-1" },
        },
      },
    ])
  })

  it("holds queued sends while a run owns the Session", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake, { enableMessageQueue: true })
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "Working"))
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Also check the logs" }],
      })
    })
    expect(fake.prompt).not.toHaveBeenCalled()
    await act(async () => {
      fake.emit({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Also check the logs" }],
        expect.objectContaining({})
      )
    })
  })

  it("holds the next queued send until the accepted turn ends", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake, { enableMessageQueue: true })
    act(() => {
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    await act(async () => {
      for (const text of ["First", "Second"])
        result.current.thread.append({
          role: "user",
          content: [{ type: "text", text }],
        })
    })
    // The proxy accepts the first send before its turn reports running.
    await act(async () => {
      fake.emit({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.prompt).toHaveBeenCalledTimes(1)

    const accepted = { sequence: 0, turnId: "run-2" }
    act(() => {
      fake.emit({ sessionUpdate: "state_update", state: "running" }, accepted)
    })
    expect(fake.prompt).toHaveBeenCalledTimes(1)
    await act(async () => {
      fake.emit(
        {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        },
        accepted
      )
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenLastCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Second" }],
        expect.objectContaining({})
      )
    })
    expect(fake.prompt).toHaveBeenCalledTimes(2)
  })

  it("sends a queued turn again, unshown, while the proxy still holds the Session", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake, { enableMessageQueue: true })
    fake.prompt.mockRejectedValueOnce(
      Object.assign(new Error("busy"), {
        code: AOS_JSONRPC_ERRORS.turnInProgress,
      })
    )
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "Working"))
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Queued" }],
      })
    })
    await act(async () => {
      fake.emit({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      })
    })

    await waitFor(() => expect(fake.prompt).toHaveBeenCalledTimes(2))
    expect(fake.prompt).toHaveBeenLastCalledWith(
      SESSION_ID,
      [{ type: "text", text: "Queued" }],
      expect.objectContaining({})
    )
    // The refusal never reached the thread.
    expect(result.current.thread.getState().messages[0]?.status).toMatchObject({
      type: "complete",
    })
  })

  it("sends the next queued turn once the accepted one fails before it runs, even ahead of the reply", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake, { enableMessageQueue: true })
    let accept!: (reply: { messageId: string }) => void
    fake.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve
        })
    )
    act(() => {
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    await act(async () => {
      for (const text of ["First", "Second"])
        result.current.thread.append({
          role: "user",
          content: [{ type: "text", text }],
        })
    })
    await act(async () => {
      fake.emit({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      fake.emit(
        {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: AOS_STOP_REASONS.error,
        },
        { sequence: 0, turnId: "run-2" }
      )
    })
    expect(fake.prompt).toHaveBeenCalledTimes(1)
    await act(async () => {
      accept({ messageId: "u1" })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenLastCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Second" }],
        expect.objectContaining({})
      )
    })
  })
})

describe("useAcpRuntime approvals", () => {
  /** A run blocked on its `bash` call, as the proxy streams it. */
  const blockOnCall = (fake: Fake) => {
    fake.emit({ sessionUpdate: "state_update", state: "running" })
    fake.emit(chunkUpdate("a1", "Deploying"))
    fake.emit(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        title: "bash",
        status: "in_progress",
      },
      { ...TURN_META, messageId: "a1" }
    )
    fake.emit({ sessionUpdate: "state_update", state: "requires_action" })
  }

  const callPart = (runtime: ReturnType<typeof useAcpRuntime>) =>
    runtime.thread.getMessageByIndex(0).getMessagePartByToolCallId("t1")

  it("answers a permission on the call it guards while sends queue", async () => {
    const fake = createFakeConnection()
    const approvals = createAcpApprovals({ connection: fake.connection })
    const { result } = await mount(fake, {
      approvals,
      enableMessageQueue: true,
    })
    let respond!: ReturnType<Fake["requestPermission"]>
    act(() => {
      blockOnCall(fake)
      respond = fake.requestPermission("t1")
    })
    expect(callPart(result.current).getState()).toMatchObject({
      approval: {
        id: "interrupt-1",
        options: [
          { id: "once", kind: "allow-once" },
          { id: "deny", kind: "reject-once" },
        ],
      },
    })

    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Also check the logs" }],
      })
    })
    expect(fake.prompt).not.toHaveBeenCalled()

    await act(async () => {
      await callPart(result.current).respondToToolApproval({
        optionId: "once",
      })
    })
    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: "selected", optionId: "once" },
    })
    expect(callPart(result.current).getState()).toMatchObject({
      approval: { optionId: "once", approved: true },
    })
  })

  it("records the verdict Assistant UI settles on", async () => {
    const fake = createFakeConnection()
    const approvals = createAcpApprovals({ connection: fake.connection })
    const { result } = await mount(fake, { approvals })
    act(() => {
      blockOnCall(fake)
      fake.requestPermission("t1")
    })

    // An explicit verdict wins over whatever the option's kind suggests.
    await act(async () => {
      await callPart(result.current).respondToToolApproval({
        optionId: "once",
        approved: false,
      })
    })
    expect(callPart(result.current).getState()).toMatchObject({
      approval: { optionId: "once", approved: false },
    })
  })

  it("shows a permission raised before the thread mounted", async () => {
    const fake = createFakeConnection()
    const approvals = createAcpApprovals({ connection: fake.connection })
    fake.requestPermission("t1")
    const { result } = await mount(fake, { approvals })
    act(() => blockOnCall(fake))

    expect(callPart(result.current).getState()).toMatchObject({
      approval: { id: "interrupt-1" },
    })
  })
})

/** An older page as `resumePage` hands it over, tagged updates and all. */
const pageOf = (
  updates: readonly SessionUpdate[],
  history: AosHistoryCursor
): AcpHistoryPage => ({
  updates: updates.map((update) => ({
    update,
    meta: { ...TURN_META, historyPage: { cursor: "tag" } },
  })),
  history,
})

const historyOf = (runtime: ReturnType<typeof useAcpRuntime>) =>
  threadHistoryExtras.tryGet(runtime.thread.getState().extras)?.history

const ids = (runtime: ReturnType<typeof useAcpRuntime>) =>
  runtime.thread.getState().messages.map((message) => message.id)

describe("useAcpRuntime older history", () => {
  const newestPage = (fake: Fake) =>
    act(() => {
      fake.emit(textUpdate("user_message", "u2", "Newer question"))
      fake.emit(textUpdate("agent_message", "a2", "Newer answer"))
    })

  const loadOlder = (runtime: ReturnType<typeof useAcpRuntime>) =>
    act(async () => {
      void historyOf(runtime)?.loadOlder()
    })

  it("offers the cursor the opening replay reported, without flipping isLoading", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result } = await mount(fake)
    newestPage(fake)

    expect(historyOf(result.current)).toMatchObject({
      hasOlder: true,
      truncated: false,
      loading: false,
      failed: false,
    })
    await loadOlder(result.current)
    expect(fake.resumePage).toHaveBeenCalledWith(SESSION_ID, "cursor-1")
    expect(historyOf(result.current)?.loading).toBe(true)
    expect(result.current.thread.getState().isLoading).toBe(false)

    await act(async () => {
      fake.answerPage(
        0,
        pageOf(
          [
            textUpdate("user_message", "u1", "First question"),
            textUpdate("agent_message", "a1", "First answer"),
          ],
          {}
        )
      )
    })
    expect(ids(result.current)).toEqual(["u1", "a1", "u2", "a2"])
    expect(historyOf(result.current)).toMatchObject({
      hasOlder: false,
      truncated: false,
      loading: false,
    })
  })

  it("reports a bound it cannot read past as truncated", async () => {
    const fake = createFakeConnection({ history: { truncated: true } })
    const { result } = await mount(fake)

    expect(historyOf(result.current)).toMatchObject({
      hasOlder: false,
      truncated: true,
    })
  })

  it("offers nothing when the proxy does not serve older pages", async () => {
    const fake = createFakeConnection({
      history: { nextCursor: "cursor-1" },
      historyPages: false,
    })
    const { result } = await mount(fake)

    expect(historyOf(result.current)).toBeUndefined()
  })

  it("offers nothing until a replay reports where history stands", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)

    expect(historyOf(result.current)).toBeUndefined()
  })

  it("keeps a live update at the end while a page lands ahead of it", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result } = await mount(fake)
    newestPage(fake)

    await loadOlder(result.current)
    act(() => {
      fake.emit(textUpdate("user_message", "u3", "Live question"))
    })
    await act(async () => {
      fake.answerPage(
        0,
        pageOf([textUpdate("user_message", "u1", "First question")], {})
      )
    })

    expect(ids(result.current)).toEqual(["u1", "u2", "a2", "u3"])
  })

  it("leaves the running turn running when a page's finished turns land", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("user_message", "u2", "Newer question"))
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })

    await loadOlder(result.current)
    await act(async () => {
      fake.answerPage(
        0,
        pageOf(
          [
            { sessionUpdate: "state_update", state: "running" },
            textUpdate("agent_message", "a1", "First answer"),
            {
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: "end_turn",
            },
          ],
          {}
        )
      )
    })

    // The running turn's own reply stays last, after the page and its question.
    expect(ids(result.current).slice(0, 2)).toEqual(["a1", "u2"])
    expect(ids(result.current)).toHaveLength(3)
    expect(result.current.thread.getState().isRunning).toBe(true)
  })

  it("keeps a turn re-keyed onto its saved rows once when a page carries them", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("user_message", "u2", "Newer question"))
      fake.emit({ sessionUpdate: "state_update", state: "running" })
      fake.emit(textUpdate("agent_message", "run-1:assistant", "Live answer"))
      fake.emit(
        {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        },
        { ...TURN_META, savedIds: { "run-1:assistant": "hermes-row-3" } }
      )
    })

    // The turn stored enough rows to shift the offsets, so the page reaches it.
    await loadOlder(result.current)
    await act(async () => {
      fake.answerPage(
        0,
        pageOf(
          [
            textUpdate("user_message", "u1", "First question"),
            textUpdate("agent_message", "hermes-row-3", "Live answer"),
          ],
          {}
        )
      )
    })

    expect(ids(result.current)).toEqual(["u1", "u2", "hermes-row-3"])
  })

  it("keeps a failed page failed until asked again, with no retry of its own", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result } = await mount(fake)
    newestPage(fake)

    await loadOlder(result.current)
    await act(async () => {
      fake.failPage(0)
    })
    expect(historyOf(result.current)).toMatchObject({
      hasOlder: true,
      loading: false,
      failed: true,
    })
    expect(fake.resumePage).toHaveBeenCalledTimes(1)

    await loadOlder(result.current)
    expect(fake.resumePage).toHaveBeenCalledTimes(2)
    expect(historyOf(result.current)?.failed).toBe(false)
  })

  it("asks for one page at a time", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result } = await mount(fake)

    await loadOlder(result.current)
    await loadOlder(result.current)
    expect(fake.resumePage).toHaveBeenCalledTimes(1)
  })

  it("drops a page that lands after a resync replaced the transcript", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result } = await mount(fake)
    newestPage(fake)

    await loadOlder(result.current)
    fake.history = { nextCursor: "cursor-fresh" }
    await act(async () => {
      await fake.resync()
      fake.emit(textUpdate("user_message", "u2", "Newer question"))
    })
    await act(async () => {
      fake.answerPage(
        0,
        pageOf([textUpdate("user_message", "u1", "First question")], {})
      )
    })

    expect(ids(result.current)).toEqual(["u2"])
    expect(historyOf(result.current)).toMatchObject({
      hasOlder: true,
      loading: false,
      failed: false,
    })
  })

  it("drops a page that lands after the thread binds another Session", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result, rerender } = renderHook(
      (props: { session: string }) =>
        useAcpRuntime({
          connection: fake.connection,
          sessionId: props.session,
          agentId: "agent-1",
        }),
      { initialProps: { session: SESSION_ID } }
    )
    await act(async () => {
      await fake.settleResume()
    })

    await loadOlder(result.current)
    await act(async () => {
      rerender({ session: "session-2" })
    })
    await act(async () => {
      fake.answerPage(
        0,
        pageOf([textUpdate("user_message", "u1", "First question")], {})
      )
    })

    expect(ids(result.current)).toEqual([])
  })

  it("takes the cursor a resync reports", async () => {
    const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
    const { result } = await mount(fake)
    newestPage(fake)
    expect(historyOf(result.current)?.hasOlder).toBe(true)

    fake.history = { nextCursor: "cursor-fresh" }
    await act(async () => {
      await fake.resync()
    })
    await loadOlder(result.current)
    expect(fake.resumePage).toHaveBeenLastCalledWith(SESSION_ID, "cursor-fresh")
  })

  describe("after an accepted rewind", () => {
    /** Retries the newest turn; the provider answers it with a new user turn. */
    const retry = (fake: Fake, runtime: ReturnType<typeof useAcpRuntime>) => {
      fake.prompt.mockResolvedValueOnce({ messageId: "u3" })
      return act(async () => {
        runtime.thread.startRun({ parentId: "u2" })
      })
    }

    it("rebuilds from the newest page before the next page, so nothing is skipped", async () => {
      const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
      const { result } = await mount(fake)
      newestPage(fake)
      await loadOlder(result.current)
      await act(async () => {
        fake.answerPage(
          0,
          pageOf([textUpdate("user_message", "u1", "First question")], {
            nextCursor: "cursor-0",
          })
        )
      })

      await retry(fake, result.current)
      await waitFor(() => expect(ids(result.current)).toEqual(["u1", "u3"]))
      // The rewind itself sends no resume: the new turn streams as it does.
      expect(fake.replay).toHaveBeenCalledTimes(1)

      fake.history = { nextCursor: "cursor-rebuilt" }
      await loadOlder(result.current)
      expect(fake.replay).toHaveBeenCalledTimes(2)
      expect(fake.replay).toHaveBeenLastCalledWith(SESSION_ID)
      expect(fake.resumePage).toHaveBeenLastCalledWith(
        SESSION_ID,
        "cursor-rebuilt"
      )
      // What the rebuild replayed: the newest page as the provider now holds it.
      act(() => {
        fake.emit(textUpdate("user_message", "u3", "Newer question"))
        fake.emit(textUpdate("agent_message", "a3", "Retried answer"))
      })
      await act(async () => {
        fake.answerPage(
          1,
          pageOf(
            [
              textUpdate("user_message", "u1", "First question"),
              textUpdate("agent_message", "a1", "First answer"),
            ],
            {}
          )
        )
      })

      expect(ids(result.current)).toEqual(["u1", "a1", "u3", "a3"])
    })

    it("drops a page still in flight when the rewind is accepted", async () => {
      const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
      const { result } = await mount(fake)
      newestPage(fake)
      await loadOlder(result.current)

      await retry(fake, result.current)
      await waitFor(() => expect(ids(result.current)).toEqual(["u3"]))
      await act(async () => {
        fake.answerPage(
          0,
          pageOf([textUpdate("user_message", "u1", "First question")], {})
        )
      })

      expect(ids(result.current)).not.toContain("u1")
      expect(fake.replay).toHaveBeenCalledTimes(1)
      expect(historyOf(result.current)).toMatchObject({
        hasOlder: true,
        loading: false,
      })

      // Asked again, it rebuilds first, then pages from the fresh cursor.
      fake.history = { nextCursor: "cursor-rebuilt" }
      await loadOlder(result.current)
      expect(fake.replay).toHaveBeenCalledTimes(2)
      expect(fake.replay).toHaveBeenLastCalledWith(SESSION_ID)
      expect(fake.resumePage).toHaveBeenLastCalledWith(
        SESSION_ID,
        "cursor-rebuilt"
      )
      expect(fake.replay.mock.invocationCallOrder.at(-1)).toBeLessThan(
        fake.resumePage.mock.invocationCallOrder.at(-1) ?? 0
      )
      act(() => {
        fake.emit(textUpdate("user_message", "u3", "Newer question"))
        fake.emit(textUpdate("agent_message", "a3", "Retried answer"))
      })
      await act(async () => {
        fake.answerPage(
          1,
          pageOf(
            [
              textUpdate("user_message", "u1", "First question"),
              textUpdate("agent_message", "a1", "First answer"),
            ],
            {}
          )
        )
      })

      expect(ids(result.current)).toEqual(["u1", "a1", "u3", "a3"])
    })

    it("keeps the cursor stale when the rewind lands during a replay", async () => {
      const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
      const { result } = await mount(fake)
      newestPage(fake)

      const reply = Promise.withResolvers<void>()
      let replayed: Promise<unknown> = Promise.resolve()
      act(() => {
        replayed = fake.resync(reply.promise)
      })
      newestPage(fake)
      await retry(fake, result.current)
      // The replay read the provider's positions before the rewind moved them.
      fake.history = { nextCursor: "cursor-before-rewind" }
      await act(async () => {
        reply.resolve()
        await replayed
      })
      expect(ids(result.current)).toEqual(["u3"])

      fake.history = { nextCursor: "cursor-rebuilt" }
      await loadOlder(result.current)
      expect(fake.replay).toHaveBeenCalledTimes(2)
      expect(fake.resumePage).toHaveBeenCalledTimes(1)
      expect(fake.resumePage).toHaveBeenLastCalledWith(
        SESSION_ID,
        "cursor-rebuilt"
      )
    })

    it("fails the load, and leaves the reader its button, when the rebuild is refused", async () => {
      const fake = createFakeConnection({ history: { nextCursor: "cursor-1" } })
      const { result } = await mount(fake)
      newestPage(fake)
      await retry(fake, result.current)
      await waitFor(() => expect(ids(result.current)).toEqual(["u3"]))

      fake.replay.mockRejectedValueOnce(RequestError.resourceNotFound())
      let load: Promise<void> | undefined
      await act(async () => {
        load = historyOf(result.current)?.loadOlder()
        await load
      })
      await expect(load).resolves.toBeUndefined()
      expect(fake.replay).toHaveBeenCalledTimes(2)
      expect(fake.resumePage).not.toHaveBeenCalled()
      expect(historyOf(result.current)).toMatchObject({
        hasOlder: true,
        loading: false,
        failed: true,
      })
      expect(ids(result.current)).toEqual(["u3"])
    })
  })
})

function Probe() {
  const execution = acpExtras.use((extras) => extras.execution)
  const todos = acpExtras.use((extras) => extras.todos)
  return (
    <div>
      <p>{`Run: ${execution.status}`}</p>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>{todo.label}</li>
        ))}
      </ul>
    </div>
  )
}

function Harness({ connection }: { connection: AcpConnection }) {
  const runtime = useAcpRuntime({
    connection,
    sessionId: SESSION_ID,
    agentId: "agent-1",
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Probe />
    </AssistantRuntimeProvider>
  )
}

describe("useAcpRuntime extras", () => {
  it("exposes the Session's execution and Todos to the tree", async () => {
    const fake = createFakeConnection()
    render(<Harness connection={fake.connection} />)
    await act(async () => {
      await fake.settleResume()
    })
    expect(screen.getByText("Run: idle")).toBeInTheDocument()
    act(() => {
      fake.emit({ sessionUpdate: "state_update", state: "running" })
      fake.emit(
        {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: AOS_PLAN_ID,
            entries: [
              { content: "Ship it", priority: "medium", status: "in_progress" },
            ],
          },
        },
        {
          ...TURN_META,
          todos: [{ id: "todo-1", label: "Ship it", status: "active" }],
        }
      )
    })
    expect(screen.getByText("Run: running")).toBeInTheDocument()
    expect(screen.getByRole("listitem")).toHaveTextContent("Ship it")
  })
})

describe("useAcpRuntime clientId", () => {
  it("includes a clientId in the prompt meta and uses different ids per send", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    const capturedIds: Array<string | undefined> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fake.prompt as any).mockImplementation(
      async (_sid: string, _blocks: unknown, meta: Record<string, unknown>) => {
        capturedIds.push(meta.clientId as string | undefined)
        return { messageId: `u${capturedIds.length}` }
      }
    )

    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Send one" }],
      })
    })
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Send two" }],
      })
    })

    await waitFor(() => expect(capturedIds).toHaveLength(2))
    expect(capturedIds[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(capturedIds[1]).toMatch(/^[0-9a-f-]{36}$/)
    expect(capturedIds[0]).not.toBe(capturedIds[1])
  })
})
