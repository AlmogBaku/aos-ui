import {
  methods,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { type SessionHistoryResponse } from "../../protocol"
import {
  ACP_PROTOCOL_VERSION,
  AOS_ATTACHMENT_URI_SCHEME,
  AOS_EXTENSION_VERSION,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_META_KEY,
  AOS_REPLAY_BEFORE,
  AOS_STOP_REASONS,
  AosHistoryCursorSchema,
  type AosActivityNotification,
} from "../../protocol/acp"
import {
  PendingRequestKind,
  PromptTurnInputSchema,
  RepliesTurnInputSchema,
  TurnEventKind,
  type PendingRequest,
} from "../core/events"
import type { ServerTurnWatcher, ServerRuntime } from "../core/runtime"
import { translateHistory } from "./translate/history"
import { invalidRequest } from "./validation"
import {
  AGENT,
  CONNECTION,
  CREATED,
  EventSource,
  NOW,
  PRINCIPAL,
  SESSION,
  USAGE,
  type Browser,
  type Recorder,
  chunk,
  endedTurn,
  flow,
  gate,
  harness,
  heldUntilWithdrawn,
  isPromptOrChunk,
  liveTurn,
  open,
  prompt,
  prompts,
  reply,
  replyWhileWatched,
  said,
  sessionRow,
  settled,
  storedLiveTurn,
  turnStarted,
  updates,
  type Recorded,
  waitFor,
  withoutStates,
} from "./test-harness"

/** Every `_meta.aos.sequence` the recorded run-stream updates carry, in order. */
function sequencesOf(recorder: Recorder) {
  const Schema = z.object({
    update: z.object({
      _meta: z.object({ [AOS_META_KEY]: z.object({ sequence: z.number() }) }),
    }),
  })
  return updates(recorder).flatMap((params) => {
    const parsed = Schema.safeParse(params)
    return parsed.success
      ? [parsed.data.update._meta[AOS_META_KEY].sequence]
      : []
  })
}

/** Every catalog relist this connection has asked the client for. */
function relists(recorder: Recorder) {
  return recorder.of(AOS_METHODS.notify.catalogInvalidated)
}

/** Every context reading this connection has pushed, newest last. */
function usages(recorder: Recorder) {
  return updates(recorder).filter((update) =>
    JSON.stringify(update).includes("usage_update")
  )
}

/** The newest reading, once the connection has pushed `count` of them. */
async function usageOf(test: { recorder: Recorder }, count = 1) {
  await test.recorder.wait(
    () => usages(test.recorder).length >= count,
    `usage reading ${count}`
  )
  return usages(test.recorder).at(-1)
}

/**
 * A provider whose window only becomes readable on the given attempt, which is
 * how a cold Session answers while its agent is still being built. `Infinity`
 * stands for one that never becomes readable.
 */
function coldWindow(readableAttempt: number): ServerRuntime["context"] {
  let attempts = 0
  return async () => {
    attempts += 1
    if (attempts < readableAttempt) throw new Error("no window")
    return USAGE
  }
}

/**
 * Fakes only the timers a deferred usage report uses, so the in-process ACP
 * connection and the test runner keep their own clocks.
 */
function useUsageTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
}

describe("AOS ACP agent", () => {
  it("reports the AOS extension contract on initialize", async () => {
    const test = await harness()

    expect(test.initialize).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      info: { name: "aos-proxy", title: "Test Runtime" },
      capabilities: { session: { delete: {}, prompt: { image: {} } } },
      authMethods: [],
      _meta: {
        [AOS_META_KEY]: {
          version: AOS_EXTENSION_VERSION,
          lane: "operator",
          extensions: {
            steer: true,
            focus: true,
            invalidation: true,
            guestProjection: false,
          },
        },
      },
    })
    test.close()
  })

  it("advertises no catalog invalidation for a runtime that cannot signal one", async () => {
    const test = await harness({ withoutCatalogChanges: true })

    expect(test.initialize).toMatchObject({
      _meta: {
        [AOS_META_KEY]: {
          extensions: { invalidation: false, steer: true, readState: true },
        },
      },
    })
    test.close()
  })

  it("creates a Session and pushes its commands and context usage", async () => {
    const test = await harness()

    const created = await test.create()

    expect(created).toMatchObject({
      sessionId: CREATED,
      configOptions: [{ configId: "model", currentValue: "sonnet" }],
      _meta: {
        [AOS_META_KEY]: {
          session: { agentId: AGENT, status: "idle", archived: false },
          capabilities: {
            workspace: { slashCommands: { commands: [{ name: "plan" }] } },
          },
        },
      },
    })
    await test.recorder.wait(
      (entry) =>
        entry.method === methods.client.session.update &&
        JSON.stringify(entry.params).includes("usage_update"),
      "an update carrying usage_update"
    )
    expect(updates(test.recorder)).toMatchObject([
      {
        sessionId: CREATED,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "plan", description: "Draft a plan" }],
        },
      },
      {
        sessionId: CREATED,
        update: {
          sessionUpdate: "usage_update",
          used: 1_200,
          size: 20_000,
          // ACP carries the counts; the provider's attribution of them and how
          // it arrived at them travel in the AOS extension's own meta.
          _meta: {
            [AOS_META_KEY]: {
              source: "provider-usage",
              breakdown: {
                systemTokens: 300,
                toolTokens: 400,
                messageTokens: 500,
              },
            },
          },
        },
      },
    ])
    test.close()
  })

  it("pages the Session list with an opaque cursor", async () => {
    const test = await harness({
      rows: [sessionRow(), sessionRow({ id: "session-2", unread: true })],
      total: 5,
    })

    const page = await test.list()

    expect(page).toMatchObject({
      sessions: [
        {
          sessionId: SESSION,
          cwd: "/",
          title: "Notes",
          _meta: { [AOS_META_KEY]: { agentId: AGENT, status: "idle" } },
        },
        {
          sessionId: "session-2",
          _meta: { [AOS_META_KEY]: { unread: true } },
        },
      ],
      nextCursor: expect.any(String) as string,
    })
    const cursor = z.object({ nextCursor: z.string() }).parse(page).nextCursor
    await test.agent.request(methods.agent.session.list, { cursor })
    expect(test.listAllSessions).toHaveBeenLastCalledWith(50, 2)
    test.close()
  })

  it("offers no cursor past the catalog window", async () => {
    const test = await harness({ rows: [sessionRow()], total: 5_000 })

    const page = await test.agent.request(methods.agent.session.list, {
      cursor: Buffer.from("999").toString("base64url"),
    })

    expect(page).not.toHaveProperty("nextCursor")
    test.close()
  })

  it("pages the Session list only by a cursor it could have issued", async () => {
    const test = await harness({ rows: [sessionRow()], total: 5 })
    const encoded = (text: string) => Buffer.from(text).toString("base64url")

    await test.agent.request(methods.agent.session.list, {
      cursor: encoded("2"),
    })
    expect(test.listAllSessions).toHaveBeenLastCalledWith(50, 2)
    for (const cursor of [
      encoded("1e3"),
      encoded("0x10"),
      encoded("-1"),
      encoded(" 2"),
      `${encoded("2")}==`,
      `${encoded("2")}!`,
      "",
    ])
      await expect(
        test.agent.request(methods.agent.session.list, { cursor })
      ).rejects.toMatchObject({ code: invalidRequest().code })
    test.close()
  })

  it("replays history, joins the live run, and reports its state", async () => {
    const test = await harness()
    await test.list()
    // A run this connection did not start: the coordinator owns it already.
    await test.coordinator.start(
      test.scope,
      { turnId: "run-live", messageId: "message-0", prompt: "Go" },
      {
        subscriberId: "rest",
        controllerId: "operator",
        lane: "operator",
        canControl: true,
      }
    )
    test.sources[0]?.emit(turnStarted())

    const resumed = await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
    })

    expect(resumed).toMatchObject({
      configOptions: [{ configId: "model" }],
      _meta: {
        [AOS_META_KEY]: {
          session: { agentId: AGENT, status: "running" },
          execution: { status: "running", turnId: "run-live" },
        },
      },
    })
    expect(updates(test.recorder)[0]).toMatchObject({
      sessionId: SESSION,
      update: { sessionUpdate: "agent_message", messageId: "message-1" },
    })
    const running = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes('"state":"running"'),
      'an update carrying "state":"running"'
    )
    expect(running.params).toMatchObject({
      sessionId: SESSION,
      update: {
        sessionUpdate: "state_update",
        state: "running",
        _meta: { [AOS_META_KEY]: { turnId: "run-live" } },
      },
    })
    test.sources[0]?.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Live",
    })
    const streamed = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("Live"),
      "an update carrying Live"
    )
    expect(streamed.params).toMatchObject({
      sessionId: SESSION,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Live" },
      },
    })
    test.close()
  })

  it("acknowledges a prompt before the turn starts and streams it to idle", async () => {
    const test = await harness()
    await test.create()

    const accepted = await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Summarize" }],
      _meta: { [AOS_META_KEY]: {} },
    })

    const messageId = z
      .object({ _meta: z.object({ aos: z.object({ messageId: z.string() }) }) })
      .parse(accepted)._meta.aos.messageId
    expect(messageId).toHaveLength(36)
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    expect(test.start.mock.calls[0]?.[0]).toMatchObject({ threadId: CREATED })
    expect(test.start.mock.calls[0]?.[1]).toMatchObject({
      messageId,
      prompt: "Summarize",
    })
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Done",
    })
    source?.emit({ kind: TurnEventKind.TurnEnded })

    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("end_turn"),
      "an update carrying end_turn"
    )
    // `session/new` and the settled turn each push usage out of band: the turn
    // grew the window, so the composer is owed the reading it left behind.
    await usageOf(test, 2)
    expect(
      updates(test.recorder).filter(
        (update) => !JSON.stringify(update).includes("usage_update")
      )
    ).toMatchObject([
      { update: { sessionUpdate: "available_commands_update" } },
      {
        update: {
          sessionUpdate: "user_message",
          messageId,
          content: [{ type: "text", text: "Summarize" }],
        },
      },
      { update: { sessionUpdate: "state_update", state: "running" } },
      {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Done" },
        },
      },
      {
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        },
      },
    ])
    // Only the proxy-minted user turn is unsequenced; the run stream is not.
    const sequences = sequencesOf(test.recorder)
    expect(sequences).toHaveLength(3)
    expect(sequences.every((value) => Number.isInteger(value))).toBe(true)
    expect([...sequences].sort((left, right) => left - right)).toEqual(
      sequences
    )
    test.close()
  })

  it("answers a permission request and starts the reply segment", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Delete it" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "permission-required",
        },
      ],
    })
    source?.finish()

    const asked = await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission,
      "the permission request"
    )

    expect(asked.params).toMatchObject({
      sessionId: CREATED,
      title: "permission-required",
      options: [{ optionId: "once", kind: "allow_once" }],
      _meta: { [AOS_META_KEY]: { requestId: "approval-1" } },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    expect(test.start.mock.calls[1]?.[1]).toMatchObject({
      replies: [
        {
          requestId: "approval-1",
          status: "resolved",
          payload: { outcome: "selected", optionId: "once" },
        },
      ],
    })
    // The reply segment is a turn of its own, not the one that asked.
    const asking = PromptTurnInputSchema.parse(test.start.mock.calls[0]?.[1])
    const reply = RepliesTurnInputSchema.parse(test.start.mock.calls[1]?.[1])
    expect(reply.turnId).not.toBe(asking.turnId)
    test.close()
  })

  it("reports a stop the provider has not settled, then the cancelled turn", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Long job" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes('"state":"running"'),
      'an update carrying "state":"running"'
    )

    await test.agent.notify(methods.agent.session.cancel, {
      sessionId: CREATED,
    })

    const stopping = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("stopping"),
      "an update carrying stopping"
    )
    expect(stopping.params).toMatchObject({
      sessionId: CREATED,
      update: {
        sessionUpdate: "state_update",
        state: "running",
        _meta: { [AOS_META_KEY]: { execution: "stopping" } },
      },
    })
    expect(source?.stop).toHaveBeenCalledTimes(1)
    source?.emit({ kind: TurnEventKind.TurnEnded })
    const settled = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("cancelled"),
      "an update carrying cancelled"
    )
    expect(settled.params).toMatchObject({
      sessionId: CREATED,
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
      },
    })
    test.close()
  })

  it("writes the Session model a config option selects", async () => {
    const test = await harness()
    await test.list()

    const written = await test.agent.request(
      methods.agent.session.setConfigOption,
      { sessionId: SESSION, configId: "model", type: "id", value: "opus" }
    )

    expect(test.updateModel).toHaveBeenCalledWith(AGENT, SESSION, {
      selectedId: "opus",
    })
    expect(written).toMatchObject({
      configOptions: [{ configId: "model", currentValue: "opus" }],
    })
    test.close()
  })

  it("restates context usage after a config option changes the model", async () => {
    const test = await harness()
    await test.list()
    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    await usageOf(test)

    await test.agent.request(methods.agent.session.setConfigOption, {
      sessionId: SESSION,
      configId: "model",
      type: "id",
      value: "opus",
    })

    // The window's size belongs to the model, so a switch owes a fresh reading.
    await usageOf(test, 2)
    test.close()
  })

  it("reports context usage on resume so a returning composer has a window", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })

    expect(await usageOf(test)).toMatchObject({
      sessionId: SESSION,
      update: {
        sessionUpdate: "usage_update",
        used: 1_200,
        size: 20_000,
        _meta: { [AOS_META_KEY]: { source: "provider-usage" } },
      },
    })
    test.close()
  })

  it("writes the resume response before the usage it pushes, however slow the provider reads", async () => {
    // A real provider answers the model catalog in its own time. The browser
    // starts listening for a Session's updates only once the resume response
    // arrives, so a reading that overtakes the response is simply lost.
    const test = await harness({
      beforeModels: () => new Promise((resolve) => setTimeout(resolve, 50)),
    })
    await test.list()

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    test.recorder.add({ method: "resume-resolved", params: undefined })

    await usageOf(test)
    const order = test.recorder.entries.map((entry) =>
      entry.method === "resume-resolved"
        ? entry.method
        : JSON.stringify(entry.params).includes("usage_update")
          ? "usage_update"
          : undefined
    )
    expect(order.filter(Boolean)).toEqual(["resume-resolved", "usage_update"])
    test.close()
  })

  it("defers the reading a resumed Session cannot take yet", async () => {
    const test = await harness({ context: coldWindow(3) })
    await test.list()
    useUsageTimers()
    try {
      await test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
      })

      // The first two reads find a provider still building its agent; the
      // backoff waits 1s and then 2s before the third one succeeds.
      await vi.advanceTimersByTimeAsync(2_999)
      expect(usages(test.recorder)).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(usages(test.recorder)).toMatchObject([
        {
          sessionId: SESSION,
          update: { sessionUpdate: "usage_update", used: 1_200, size: 20_000 },
        },
      ])

      // One reading settles the report: nothing is pending and nothing repeats.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(usages(test.recorder)).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      test.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves the last reading standing when the provider cannot report usage", async () => {
    const test = await harness({ context: coldWindow(Infinity) })
    await test.list()
    useUsageTimers()
    try {
      await test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
      })
      await vi.advanceTimersByTimeAsync(60_000)

      // An unreadable window is not an outcome the operator is owed a notice
      // about, and no reading is sent rather than one claiming an empty context.
      // The backoff gives up after its budget instead of retrying forever.
      expect(usages(test.recorder)).toEqual([])
      expect(
        test.recorder.of(AOS_METHODS.notify.error).map((entry) => entry.params)
      ).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      test.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops a deferred reading once the client closes the Session", async () => {
    const test = await harness({ context: coldWindow(2) })
    await test.list()
    useUsageTimers()
    try {
      await test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
      })
      await vi.advanceTimersByTimeAsync(0)

      await test.agent.request(methods.agent.session.close, {
        sessionId: SESSION,
      })

      // A left member has no client to report a window to, so closing
      // the Session cancels the deferred attempt instead of leaving it pending.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(usages(test.recorder)).toEqual([])
      test.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("replaces a deferred reading with the one a later trigger takes", async () => {
    const test = await harness({ context: coldWindow(2) })
    await test.list()
    useUsageTimers()
    try {
      await test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(usages(test.recorder)).toEqual([])

      await test.agent.request(methods.agent.session.setConfigOption, {
        sessionId: SESSION,
        configId: "model",
        type: "id",
        value: "opus",
      })
      await vi.advanceTimersByTimeAsync(0)

      // The model switch takes the reading the resume was still waiting for, so
      // the deferred attempt is cancelled rather than left to report a second.
      expect(usages(test.recorder)).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(usages(test.recorder)).toHaveLength(1)
      test.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("brings every operator browser each usage and model reading exactly once", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await open(test)
    await usageOf(test)
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await usageOf(other)

    await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({ kind: TurnEventKind.ModelChanged, modelId: "opus" })
    source?.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Done",
    })
    source?.emit({ kind: TurnEventKind.TurnEnded })
    for (const browser of [test, other]) {
      await browser.recorder.wait(endedTurn, "the turn to end")
      await usageOf(browser, 2)
    }

    await test.agent.request(methods.agent.session.setConfigOption, {
      sessionId: SESSION,
      configId: "model",
      type: "id",
      value: "sonnet",
    })
    await usageOf(test, 3)
    await usageOf(other, 3)
    await settled()

    // One reading on joining, one after the turn, and one after the config
    // change, which moved the window every browser on the Session holds.
    for (const browser of [test, other]) {
      expect(usages(browser.recorder)).toHaveLength(3)
      expect(
        updates(browser.recorder).filter((update) =>
          JSON.stringify(update).includes("config_option_update")
        )
      ).toHaveLength(1)
    }
    test.close()
    other.close()
  })

  it("renames a Session and reports the new row", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      title: "Renamed",
    })

    expect(test.updateSession).toHaveBeenCalledWith(AGENT, SESSION, {
      title: "Renamed",
    })
    expect(updates(test.recorder)).toMatchObject([
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "session_info_update",
          title: "Renamed",
          _meta: { [AOS_META_KEY]: { agentId: AGENT, status: "idle" } },
        },
      },
    ])
    test.close()
  })

  it("pins a Session and asks the acting client to relist", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      pinned: true,
    })

    expect(test.updateSession).toHaveBeenCalledWith(AGENT, SESSION, {
      pinned: true,
    })
    expect(updates(test.recorder)).toMatchObject([
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { [AOS_META_KEY]: { agentId: AGENT, pinned: true } },
        },
      },
    ])
    expect(relists(test.recorder)).toHaveLength(1)
    test.close()
  })

  it("asks for a relist after archiving a Session but not after renaming one", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      archived: true,
    })

    expect(test.updateSession).toHaveBeenCalledWith(AGENT, SESSION, {
      archived: true,
    })
    expect(relists(test.recorder)).toHaveLength(1)

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      title: "Renamed",
    })

    // A title leaves the catalog's membership and order alone.
    expect(relists(test.recorder)).toHaveLength(1)
    test.close()
  })

  it("marks a Session read through the connection's read state", async () => {
    const test = await harness()
    await test.list()

    await test.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      unread: false,
    })

    expect(test.readState.markRead).toHaveBeenCalledWith(AGENT, SESSION)
    expect(test.updateSession).not.toHaveBeenCalled()
    test.close()
  })

  it("steers the active run and reports the delivery", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Start" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    await waitFor(() =>
      expect(
        test.coordinator.state({ agentId: AGENT, sessionId: CREATED })
      ).toBe("running")
    )

    const steered = await test.agent.request(AOS_METHODS.session.steer, {
      sessionId: CREATED,
      requestId: "steer-1",
      text: "Also check the tests",
    })

    expect(steered).toEqual({ status: "steered" })
    const accepted = await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.steerAccepted,
      "the steer acknowledgement"
    )
    expect(accepted.params).toMatchObject({
      sessionId: CREATED,
      requestId: "steer-1",
      text: "Also check the tests",
      delivery: "steered",
    })
    test.close()
  })

  it("reports Session focus and blur to read state", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await waitFor(() =>
      expect(test.readState.focus).toHaveBeenCalledWith(AGENT, SESSION)
    )
    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: null })
    await waitFor(() => expect(test.readState.blur).toHaveBeenCalled())
    test.close()
  })

  it("records the presence an exposed Session implies", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })

    await waitFor(() =>
      expect(test.presence.set).toHaveBeenCalledWith(PRINCIPAL, CONNECTION, {
        sessionId: SESSION,
        foreground: true,
        idle: false,
      })
    )
    test.close()
  })

  it("records a reported background or idle workspace as reported", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, {
      sessionId: SESSION,
      foreground: false,
      idle: true,
    })

    await waitFor(() =>
      expect(test.presence.set).toHaveBeenCalledWith(PRINCIPAL, CONNECTION, {
        sessionId: SESSION,
        foreground: false,
        idle: true,
      })
    )
    test.close()
  })

  it("records a foreground workspace showing no Session, and still blurs", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, {
      sessionId: null,
      foreground: true,
    })

    await waitFor(() =>
      expect(test.presence.set).toHaveBeenCalledWith(PRINCIPAL, CONNECTION, {
        sessionId: null,
        foreground: true,
        idle: false,
      })
    )
    expect(test.readState.blur).toHaveBeenCalled()
    test.close()
  })

  it("acknowledges an exposure once, however often its heartbeat repeats it", async () => {
    const test = await harness()
    await test.list()

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await waitFor(() =>
      expect(test.readState.focus).toHaveBeenCalledWith(AGENT, SESSION)
    )
    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await test.agent.notify(AOS_METHODS.session.focus, {
      sessionId: SESSION,
      foreground: true,
      idle: false,
    })

    await waitFor(() => expect(test.presence.set).toHaveBeenCalledTimes(3))
    expect(test.readState.focus).toHaveBeenCalledTimes(1)
    test.close()
  })

  it("forgets this connection's presence when it closes", async () => {
    const test = await harness()
    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: SESSION })
    await waitFor(() => expect(test.presence.set).toHaveBeenCalled())

    test.close()

    await waitFor(() =>
      expect(test.presence.clear).toHaveBeenCalledWith(PRINCIPAL, CONNECTION)
    )
  })

  it("hydrates the connection with the activity snapshot", async () => {
    const event: AosActivityNotification = {
      type: "turn-started",
      agentId: AGENT,
      sessionId: SESSION,
      occurredAt: NOW,
      turnId: "lifecycle-1",
    }
    const test = await harness({ activity: [event] })

    const hydrated = await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.activity,
      "an activity notification"
    )

    expect(hydrated.params).toEqual(event)
    test.publishActivity({ ...event, turnId: "lifecycle-2" })
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("lifecycle-2"),
      "an update carrying lifecycle-2"
    )
    test.close()
  })

  it("refuses a prompt while a turn is in progress", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "First" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))

    await expect(
      test.agent.request(methods.agent.session.prompt, {
        sessionId: CREATED,
        prompt: [{ type: "text", text: "Second" }],
        _meta: { [AOS_META_KEY]: {} },
      })
    ).rejects.toMatchObject({ code: AOS_JSONRPC_ERRORS.turnInProgress })
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
  })

  it("withdraws a request the provider no longer holds and drops its reply", async () => {
    const answer = Promise.withResolvers<RequestPermissionResponse>()
    const withdrawal = Promise.withResolvers<AbortSignal>()
    const test = await harness({
      permission: (_params, signal) => {
        withdrawal.resolve(signal)
        return answer.promise
      },
    })
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Delete it" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "permission-required",
        },
      ],
    })
    source?.finish()
    await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission,
      "the permission request"
    )

    // The provider authoritatively clears the recovered wait.
    await test.agent.request(methods.agent.session.resume, {
      sessionId: CREATED,
      cwd: "/",
    })
    expect(test.discover).toHaveBeenCalled()
    const signal = await withdrawal.promise
    await waitFor(() => expect(signal.aborted).toBe(true))
    answer.resolve({ outcome: { outcome: "selected", optionId: "once" } })

    await settled()
    expect(test.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
  })

  it("reports nothing for a browser that left with a request outstanding", async () => {
    // A server→client request the operator never answered rejects when the tab
    // carrying it closes. That is the operator moving on, not a failure this
    // deployment has to answer for, and reporting it as one buries the failures
    // that are real.
    const answer = Promise.withResolvers<RequestPermissionResponse>()
    const test = await harness({ permission: () => answer.promise })
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Delete it" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "permission-required",
        },
      ],
    })
    source?.finish()
    await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission,
      "the permission request"
    )

    test.close()
    // Long enough for the abandoned request to reject and settle its handlers.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(test.logged()).not.toContainEqual(
      expect.objectContaining({ event: "acp.error" })
    )
  })

  it("logs the connection, the Stop it received, and the reply it settled", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Delete it" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [
        {
          requestId: "approval-1",
          kind: PendingRequestKind.Permission,
          message: "permission-required",
        },
      ],
    })
    source?.finish()
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))

    await test.agent.notify(methods.agent.session.cancel, {
      sessionId: CREATED,
    })
    await waitFor(() =>
      expect(test.logged()).toContainEqual({
        event: "acp.turn.cancel",
        connectionId: "connection-1",
        lane: "operator",
        sessionId: CREATED,
      })
    )

    expect(test.logged()).toContainEqual({
      event: "acp.connection.opened",
      connectionId: "connection-1",
      lane: "operator",
    })
    expect(test.logged()).toContainEqual({
      event: "acp.request.answered",
      connectionId: "connection-1",
      sessionId: CREATED,
      requestId: "approval-1",
      status: "resolved",
    })

    test.close()
    await waitFor(() =>
      expect(test.logged()).toContainEqual({
        event: "acp.connection.closed",
        connectionId: "connection-1",
        lane: "operator",
      })
    )
  })

  it("logs the code and message a failed run reported, not only its class", async () => {
    const test = await harness()
    await test.create()
    await test.agent.request(methods.agent.session.prompt, {
      sessionId: CREATED,
      prompt: [{ type: "text", text: "Long job" }],
      _meta: { [AOS_META_KEY]: {} },
    })
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    const source = test.sources[0]
    source?.emit(turnStarted())
    source?.emit({
      kind: TurnEventKind.TurnFailed,
      message: "the transport dropped",
      code: "AOS_CONNECTION_INTERRUPTED",
    })
    source?.finish()

    // The proxy mints the run id the browser sees, so the line reports that one.
    await waitFor(() =>
      expect(test.logged()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "acp.turn.failed",
            connectionId: "connection-1",
            sessionId: CREATED,
            stopReason: AOS_STOP_REASONS.uncertain,
            errorCode: "AOS_CONNECTION_INTERRUPTED",
            message: "the transport dropped",
            turnId: expect.any(String),
          }),
        ])
      )
    )
    test.close()
  })
})

const QUESTION: PendingRequest = {
  requestId: "question-1",
  kind: PendingRequestKind.Elicitation,
  message: "Which one?",
}

const APPROVAL: PendingRequest = {
  requestId: "approval-1",
  kind: PendingRequestKind.Permission,
  message: "permission-required",
}

describe("Session rooms", () => {
  it("shows an open Session another browser's prompt, then its stream", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    const from = other.recorder.entries.length

    const messageId = await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [other, test])

    const turn = [
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
      "state idle",
    ]
    expect(flow(other.recorder, SESSION, from)).toEqual(turn)
    expect(flow(test.recorder)).toEqual(turn)
    expect(prompts(other.recorder)).toEqual([
      [{ type: "text", text: "Summarize" }],
    ])
    test.close()
    other.close()
  })

  it("shows nobody a prompt the provider refused", async () => {
    const test = await harness({
      providerIds: true,
      onStart: () => {
        throw new Error("refused")
      },
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)

    await prompt(test, "Summarize")
    // The sender reads its accepted prompt's turn as one that failed at once.
    const failed = await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes(AOS_STOP_REASONS.error),
      "a failed state_update"
    )
    expect(failed.params).toMatchObject({
      sessionId: SESSION,
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: AOS_STOP_REASONS.error,
        _meta: {
          [AOS_META_KEY]: {
            turnId: expect.any(String),
            code: "internal_error",
          },
        },
      },
    })
    expect(
      test.recorder.entries.some(
        (entry) => entry.method === AOS_METHODS.notify.error
      )
    ).toBe(false)
    const late = await test.connect("connection-3")
    await late.list()
    await open(late)

    expect(prompts(other.recorder)).toEqual([])
    expect(prompts(late.recorder)).toEqual([])
    test.close()
    other.close()
    late.close()
  })

  it("lets another operator browser stop the turn", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await prompt(test, "Long job")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    await other.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes('"state":"running"'),
      'an update carrying "state":"running"'
    )

    await other.agent.notify(methods.agent.session.cancel, {
      sessionId: SESSION,
    })

    await waitFor(() => expect(test.sources[0]?.stop).toHaveBeenCalledOnce())
    test.close()
    other.close()
  })

  it("asks every browser, takes the first answer, and streams the rest to all", async () => {
    const late = gate()
    const withdrawal = Promise.withResolvers<AbortSignal>()
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2", {
      permission: async (_params, signal) => {
        withdrawal.resolve(signal)
        await late.held
        return { outcome: { outcome: "selected", optionId: "once" } }
      },
    })
    await other.list()
    await open(other)
    await prompt(test, "Delete it")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()
    const asked = (entry: Recorded) =>
      entry.method === methods.client.session.requestPermission
    await other.recorder.wait(asked, "the request both browsers are asked")
    await test.recorder.wait(asked, "the request both browsers are asked")

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    await replyWhileWatched(test.sources[1], "Resumed", [other])
    expect(flow(other.recorder)).toContain("chunk Resumed")

    // The first answer withdrew the request from the other browser, so the
    // answer it gives anyway is dropped rather than refused.
    const signal = await withdrawal.promise
    await waitFor(() => expect(signal.aborted).toBe(true))
    late.release()
    await settled()
    expect(other.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(test.start).toHaveBeenCalledTimes(2)
    test.close()
    other.close()
  })

  it("withdraws a question from the other browser once one answers it", async () => {
    const answer = gate()
    const withdrawal = Promise.withResolvers<AbortSignal>()
    const test = await harness({
      providerIds: true,
      question: async () => {
        await answer.held
        return { action: "accept", content: {} }
      },
    })
    await test.list()
    const other = await test.connect("connection-2", {
      question: (_params, signal) => {
        withdrawal.resolve(signal)
        return heldUntilWithdrawn(signal)
      },
    })
    await other.list()
    await open(other)
    await prompt(test, "Pick one")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [QUESTION],
    })
    test.sources[0]?.finish()
    const asked = (entry: Recorded) =>
      entry.method === methods.client.elicitation.create
    await other.recorder.wait(asked, "the request both browsers are asked")
    await test.recorder.wait(asked, "the request both browsers are asked")
    answer.release()

    const signal = await withdrawal.promise
    await waitFor(() => expect(signal.aborted).toBe(true))
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    await replyWhileWatched(test.sources[1], "Resumed", [other])
    expect(flow(other.recorder)).toContain("chunk Resumed")
    expect(other.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    test.close()
    other.close()
  })

  it("continues a two-question turn once two browsers each answer one", async () => {
    const SECOND: PendingRequest = { ...QUESTION, requestId: "question-2" }
    const withdrawn: AbortSignal[] = []
    /**
     * Answers the question asked `mine`th, in the order the turn asks them, and
     * holds the other until it is withdrawn.
     */
    const answering = (mine: number) => {
      let asked = 0
      return (_params: unknown, signal: AbortSignal) => {
        if (asked++ === mine)
          return Promise.resolve({ action: "accept" as const, content: {} })
        withdrawn.push(signal)
        return heldUntilWithdrawn(signal)
      }
    }
    const test = await harness({ providerIds: true, question: answering(0) })
    await test.list()
    await open(test)
    const other = await test.connect("connection-2", {
      question: answering(1),
    })
    await other.list()
    await open(other)
    await prompt(test, "Pick two")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [QUESTION, SECOND],
    })
    test.sources[0]?.finish()

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    expect(test.start.mock.calls[1]?.[1]).toMatchObject({
      replies: [
        { requestId: QUESTION.requestId },
        { requestId: SECOND.requestId },
      ],
    })
    // Each answer withdrew its question from the browser that held it.
    expect(withdrawn.map(({ aborted }) => aborted)).toEqual([true, true])
    await replyWhileWatched(test.sources[1], "Resumed", [test, other])
    expect(flow(test.recorder)).toContain("chunk Resumed")
    expect(flow(other.recorder)).toContain("chunk Resumed")
    expect(test.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(other.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    test.close()
    other.close()
  })

  it("withdraws every browser's request when Stop ends the wait", async () => {
    const signals: AbortSignal[] = []
    const holding = async (_params: unknown, signal: AbortSignal) => {
      signals.push(signal)
      return heldUntilWithdrawn(signal)
    }
    const test = await harness({ providerIds: true, permission: holding })
    await test.list()
    const other = await test.connect("connection-2", { permission: holding })
    await other.list()
    await open(other)
    await prompt(test, "Delete it")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.stop.mockResolvedValue("idle")
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()
    await waitFor(() => expect(signals).toHaveLength(2))

    await test.agent.notify(methods.agent.session.cancel, {
      sessionId: SESSION,
    })

    await waitFor(() =>
      expect(signals.map(({ aborted }) => aborted)).toEqual([true, true])
    )
    await settled()
    expect(test.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(other.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
    other.close()
  })

  it("takes the first of two answers given at once and continues the turn once", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await prompt(test, "Delete it")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    await replyWhileWatched(test.sources[1], "Resumed", [test, other])

    // The later answer lands on a withdrawn request, which is no failure.
    await settled()
    expect(test.start).toHaveBeenCalledTimes(2)
    expect(test.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(other.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(flow(test.recorder)).toContain("chunk Resumed")
    expect(flow(other.recorder)).toContain("chunk Resumed")
    test.close()
    other.close()
  })

  it("joins a live turn with its history, then its prompt, then its stream", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const messageId = await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.MessageChunk,
      messageId: "assistant-1",
      text: "Live",
    })
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("Live"),
      "an update carrying Live"
    )

    const other = await test.connect("connection-2")
    await other.list()
    await open(other, { replayFrom: { type: "start" } })
    await other.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("Live"),
      "an update carrying Live"
    )

    const seen = flow(other.recorder)
    expect(seen.slice(0, 3)).toEqual([
      "history message-1",
      `prompt ${messageId}`,
      "state running",
    ])
    expect(seen.filter((item) => item.startsWith("prompt"))).toHaveLength(1)
    expect(seen.filter((item) => item === "chunk Live")).toHaveLength(1)
    test.close()
    other.close()
  })

  it("shows a live turn history already stored once, after its prompt", async () => {
    const test = await harness({ providerIds: true, history: storedLiveTurn() })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await liveTurn(test, [test])

    await open(other, { replayFrom: { type: "start" } })
    chunk(test.sources[0], "More")
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await other.recorder.wait(endedTurn, "the turn to end")

    expect(prompts(other.recorder)).toEqual([])
    expect(withoutStates(flow(other.recorder))).toEqual([
      "history user-1",
      "chunk Live",
      "chunk More",
    ])
    test.close()
    other.close()
  })

  it("shows a correction the live turn stored once, from its stream", async () => {
    const test = await harness({
      providerIds: true,
      history: storedLiveTurn(undefined, "Use the tables"),
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await liveTurn(test, [test])
    await test.agent.request(AOS_METHODS.session.steer, {
      sessionId: SESSION,
      requestId: "steer-1",
      text: "Use the tables",
    })
    await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.steerAccepted,
      "the steer acknowledgement"
    )

    await open(other, { replayFrom: { type: "start" } })
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await other.recorder.wait(endedTurn, "the turn to end")

    expect(withoutStates(flow(other.recorder))).toEqual([
      "history user-1",
      "chunk Live",
    ])
    expect(
      other.recorder
        .of(AOS_METHODS.notify.steerAccepted)
        .map(({ params }) => params)
    ).toMatchObject([{ requestId: "steer-1", text: "Use the tables" }])
    test.close()
    other.close()
  })

  it("keeps a page that ends on an earlier prompt with the same text", async () => {
    const test = await harness({
      providerIds: true,
      history: storedLiveTurn(NOW),
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await liveTurn(test, [test])

    await open(other, { replayFrom: { type: "start" } })
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await other.recorder.wait(endedTurn, "the turn to end")

    expect(flow(other.recorder)).toContain("history assistant-0")
    test.close()
    other.close()
  })

  it("keeps the page of a discovered turn nobody here sent", async () => {
    const test = await harness({
      providerIds: true,
      rows: [sessionRow({ status: "running" })],
      discover: async () => ({ handle: new EventSource(), state: "running" }),
      history: storedLiveTurn(),
    })
    await test.list()

    await open(test, { replayFrom: { type: "start" } })

    expect(test.coordinator.state(test.scope)).toBe("running")
    expect(flow(test.recorder)).toContain("history assistant-0")
    test.close()
  })

  it("keeps what a resumed turn stored before its question for a joining tab", async () => {
    const asked = new Date(Date.now() - 60_000).toISOString()
    const test = await harness({
      providerIds: true,
      history: storedLiveTurn(asked),
    })
    await test.list()
    await liveTurn(test, [test])
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    test.sources[1]?.emit(turnStarted())
    chunk(test.sources[1], "Resumed")
    await test.recorder.wait(said("Resumed"), "an update carrying Resumed")

    const other = await test.connect("connection-2")
    await other.list()
    await open(other, { replayFrom: { type: "start" } })
    test.sources[1]?.emit({ kind: TurnEventKind.TurnEnded })
    await other.recorder.wait(endedTurn, "the turn to end")

    expect(withoutStates(flow(other.recorder))).toEqual([
      "history user-1",
      "history assistant-0",
      "chunk Resumed",
    ])
    test.close()
    other.close()
  })

  it("streams a resumed turn once to the tab that reopens it", async () => {
    const asked = new Date(Date.now() - 60_000).toISOString()
    const test = await harness({
      providerIds: true,
      history: storedLiveTurn(asked),
    })
    await test.list()
    await liveTurn(test, [test])
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    test.sources[1]?.emit(turnStarted())
    chunk(test.sources[1], "Resumed")
    await test.recorder.wait(said("Resumed"), "an update carrying Resumed")

    const from = test.recorder.entries.length
    await open(test, { replayFrom: { type: "start" } })
    chunk(test.sources[1], "After")
    test.sources[1]?.emit({ kind: TurnEventKind.TurnEnded })
    await test.recorder.wait(
      () => flow(test.recorder, SESSION, from).includes("state idle"),
      "the reloaded turn to settle idle"
    )

    expect(withoutStates(flow(test.recorder, SESSION, from))).toEqual([
      "history user-1",
      "history assistant-0",
      "chunk Resumed",
      "chunk After",
    ])
    test.close()
  })

  it("has a reopened tab reload when its page fails after its stream stopped", async () => {
    let unreadable = false
    const test = await harness({
      providerIds: true,
      beforeHistory: async () => {
        if (unreadable) throw new Error("history unavailable")
      },
    })
    await test.list()
    await liveTurn(test, [test])

    unreadable = true
    // The second reopen stands for the reload the first one asked for.
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        open(test, { replayFrom: { type: "start" } })
      ).rejects.toThrow()

    expect(
      test.recorder.of(AOS_METHODS.notify.sessionInvalidated)
    ).toHaveLength(1)
    test.close()
  })

  it.each([
    ["read", "beforeHistory"],
    ["replayed", "onReplay"],
  ] as const)(
    "streams the live turn to a reopened tab whose page fails again to be %s",
    async (_step, hook) => {
      let unreadable = false
      const test = await harness({
        providerIds: true,
        // Throws synchronously, failing the step its hook runs in.
        [hook]: () => {
          if (unreadable) throw new Error("history unavailable")
          return Promise.resolve()
        },
      })
      await test.list()
      const messageId = await liveTurn(test, [test])

      unreadable = true
      await expect(
        open(test, { replayFrom: { type: "start" } })
      ).rejects.toThrow()
      // The reload the first failure asked for fails the same way.
      const from = test.recorder.entries.length
      await expect(
        open(test, { replayFrom: { type: "start" } })
      ).rejects.toThrow()
      chunk(test.sources[0], "After")
      await test.recorder.wait(said("After"), "an update carrying After")

      expect(
        flow(test.recorder, SESSION, from).filter(isPromptOrChunk)
      ).toEqual([`prompt ${messageId}`, "chunk Live", "chunk After"])
      expect(
        test.recorder.of(AOS_METHODS.notify.sessionInvalidated)
      ).toHaveLength(1)
      test.close()
    }
  )

  it("streams a turn admitted while a reopen's page fails to that tab", async () => {
    const reading = gate()
    const page = gate()
    let held = false
    const test = await harness({
      providerIds: true,
      beforeHistory: async () => {
        if (!held) return
        reading.release()
        await page.held
        throw new Error("history unavailable")
      },
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)

    held = true
    const from = other.recorder.entries.length
    const reopened = expect(
      open(other, { replayFrom: { type: "start" } })
    ).rejects.toThrow()
    await reading.held
    const messageId = await liveTurn(test, [test])
    await settled()
    page.release()
    await reopened
    await other.recorder.wait(said("Live"), "an update carrying Live")

    expect(flow(other.recorder, SESSION, from).filter(isPromptOrChunk)).toEqual(
      [`prompt ${messageId}`, "chunk Live"]
    )
    test.close()
    other.close()
  })

  it("streams a later turn to a tab whose reopened page fails to replay", async () => {
    let failing = false
    const test = await harness({
      providerIds: true,
      onReplay: () => {
        if (failing) throw new Error("unreadable page")
      },
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)

    failing = true
    await expect(
      open(other, { replayFrom: { type: "start" } })
    ).rejects.toThrow()
    failing = false
    const from = other.recorder.entries.length
    const messageId = await liveTurn(test, [test, other])

    expect(flow(other.recorder, SESSION, from).filter(isPromptOrChunk)).toEqual(
      [`prompt ${messageId}`, "chunk Live"]
    )
    test.close()
    other.close()
  })

  it("shows a turn admitted while a reopen reads history after that page", async () => {
    const reading = gate()
    const page = gate()
    let held = false
    const test = await harness({
      providerIds: true,
      beforeHistory: () => {
        if (!held) return Promise.resolve()
        reading.release()
        return page.held
      },
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)

    held = true
    const from = other.recorder.entries.length
    const reopened = open(other, { replayFrom: { type: "start" } })
    await reading.held
    const messageId = await liveTurn(test, [test])
    await settled()
    page.release()
    await reopened
    await other.recorder.wait(said("Live"), "an update carrying Live")

    const seen = flow(other.recorder, SESSION, from)
    expect(seen[0]).toBe("history message-1")
    expect(seen.filter(isPromptOrChunk)).toEqual([
      `prompt ${messageId}`,
      "chunk Live",
    ])
    test.close()
    other.close()
  })

  it("asks a reopen to reload when its turn ends before it follows", async () => {
    const test: Awaited<ReturnType<typeof harness>> = await harness({
      providerIds: true,
      onReplay: () => test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded }),
    })
    await test.list()
    await liveTurn(test, [test])

    const resumed = await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
    })

    expect(
      z
        .object({ _meta: z.object({ aos: z.object({ resync: z.boolean() }) }) })
        .parse(resumed)._meta.aos.resync
    ).toBe(true)
    // A view rebuilt from the start reloads on invalidation, not on `resync`.
    await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.sessionInvalidated,
      "the Session invalidation"
    )
    test.close()
  })

  it("asks a reopen to reload when the turn it cut ends before it follows", async () => {
    const test: Awaited<ReturnType<typeof harness>> = await harness({
      providerIds: true,
      history: storedLiveTurn(),
      onReplay: () => test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded }),
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await liveTurn(test, [test])

    const resumed = await other.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
    })

    expect(
      z
        .object({ _meta: z.object({ aos: z.object({ resync: z.boolean() }) }) })
        .parse(resumed)._meta.aos.resync
    ).toBe(true)
    test.close()
    other.close()
  })

  it("adds no prompt to a resume whose cursor is inside the turn", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    await test.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes('"state":"running"'),
      'an update carrying "state":"running"'
    )
    const { turnId } = test.coordinator.snapshot(test.scope)

    const other = await test.connect("connection-2")
    await other.list()
    await open(other, { _meta: { [AOS_META_KEY]: { turnId, after: 1 } } })
    await replyWhileWatched(test.sources[0], "Done", [other])

    expect(prompts(other.recorder)).toEqual([])
    expect(flow(other.recorder)).toContain("chunk Done")
    test.close()
    other.close()
  })

  it("gives a reconnect without a cursor the prompt once, then the stream", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const messageId = await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())

    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await replyWhileWatched(test.sources[0], "Done", [other])

    const seen = flow(other.recorder)
    expect(seen.slice(0, 2)).toEqual([`prompt ${messageId}`, "state running"])
    expect(seen.filter((item) => item.startsWith("prompt"))).toHaveLength(1)
    expect(seen).toContain("chunk Done")
    test.close()
    other.close()
  })

  it("invents no prompt for a discovered turn nobody here sent", async () => {
    // A follow without a journal reloads history instead of streaming.
    const test = await harness({
      providerIds: true,
      rows: [sessionRow({ status: "running" })],
      discover: async () => ({ handle: new EventSource(), state: "running" }),
    })
    await test.list()
    await open(test)
    const late = await test.connect("connection-3")
    await late.list()
    await open(late)

    expect(test.coordinator.state(test.scope)).toBe("running")
    expect(prompts(test.recorder)).toEqual([])
    expect(prompts(late.recorder)).toEqual([])
    test.close()
    late.close()
  })

  it("gives a browser that joins while the turn is admitted its prompt once, first", async () => {
    const admission = gate()
    const test = await harness({
      providerIds: true,
      onStart: () => admission.held,
    })
    await test.list()
    const messageId = await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))

    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    const from = other.recorder.entries.length
    admission.release()
    await replyWhileWatched(test.sources[0], "Done", [other])

    expect(flow(other.recorder, SESSION, from)).toEqual([
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
      "state idle",
    ])
    test.close()
    other.close()
  })

  it("sends a turn of attachments alone as the stage's own prompt", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const stageId = test.attachmentStages.create(AGENT, SESSION, {
      public: [],
      appendTo: (text) => [text, "[image one]", "[image two]"].join(""),
      cleanup: async () => undefined,
    })
    const link = (id: string) => ({
      type: "resource_link" as const,
      uri: `${AOS_ATTACHMENT_URI_SCHEME}${stageId}/${id}`,
      name: `${id}.jpg`,
      mimeType: "image/jpeg",
    })

    await prompt(test, [link("one"), link("two")], SESSION, {
      attachmentStageId: stageId,
    })

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    expect(test.start.mock.calls[0]?.[1]).toMatchObject({
      prompt: "[image one][image two]",
    })
    test.close()
  })

  it("refuses a prompt with neither text nor attachments", async () => {
    const test = await harness({ providerIds: true })
    await test.list()

    await expect(prompt(test, [])).rejects.toMatchObject({
      code: AOS_JSONRPC_ERRORS.invalidRequest,
    })
    expect(test.start).not.toHaveBeenCalled()
    test.close()
  })

  it("lets a losing prompt follow the winner it raced before admission", async () => {
    const admission = gate()
    const test = await harness({
      providerIds: true,
      onStart: () => admission.held,
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    const messageId = await prompt(test, "First")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))

    // The winner is still being admitted, so the loser passes the idle check
    // and loses at the coordinator.
    await prompt(other, "Second")
    const refused = await other.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.error,
      "an _aos/error notification"
    )
    expect(refused.params).toMatchObject({ code: "turn_in_progress" })
    admission.release()
    await replyWhileWatched(test.sources[0], "Done", [other])

    const seen = flow(other.recorder)
    expect(seen.filter((item) => item === `prompt ${messageId}`)).toHaveLength(
      1
    )
    expect(seen.indexOf("chunk Done")).toBeGreaterThan(
      seen.indexOf(`prompt ${messageId}`)
    )
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
    other.close()
  })

  it("lets a losing prompt follow the winner that was admitted first", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    // The loser passes the idle check, then waits on its staged attachment
    // while the winner is admitted and announced.
    const staged = gate()
    const appendTo = vi.fn(async (text: string) => {
      await staged.held
      return text
    })
    const stageId = other.attachmentStages.create(AGENT, SESSION, {
      public: [],
      appendTo,
      cleanup: async () => undefined,
    })
    const losing = prompt(other, "Second", SESSION, {
      attachmentStageId: stageId,
    })
    await waitFor(() => expect(appendTo).toHaveBeenCalledOnce())
    const messageId = await prompt(test, "First")
    await waitFor(() =>
      expect(test.coordinator.state(test.scope)).toBe("running")
    )

    staged.release()
    await losing
    const refused = await other.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.error,
      "an _aos/error notification"
    )
    expect(refused.params).toMatchObject({ code: "turn_in_progress" })
    await replyWhileWatched(test.sources[0], "Done", [other])

    const seen = flow(other.recorder)
    expect(seen.filter((item) => item === `prompt ${messageId}`)).toHaveLength(
      1
    )
    expect(seen.indexOf("chunk Done")).toBeGreaterThan(
      seen.indexOf(`prompt ${messageId}`)
    )
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
    other.close()
  })

  it.each([
    ["a browser the room brought in", "other"],
    ["the sender", "test"],
  ] as const)(
    "shows %s the prompt again when it reopens the Session from the start",
    async (_, who) => {
      const test = await harness({ providerIds: true })
      await test.list()
      const other = await test.connect("connection-2")
      await other.list()
      await open(other)
      const reopening = who === "test" ? test : other
      const messageId = await liveTurn(test, [reopening])

      // The browser drops its transcript and replays a page that has not
      // persisted the in-flight prompt yet.
      const from = reopening.recorder.entries.length
      await open(reopening, { replayFrom: { type: "start" } })
      chunk(test.sources[0], "More")
      test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
      await reopening.recorder.wait(endedTurn, "the turn to end")

      const seen = flow(reopening.recorder, SESSION, from)
      expect(seen.slice(0, 3)).toEqual([
        "history message-1",
        `prompt ${messageId}`,
        "state running",
      ])
      expect(seen.filter(isPromptOrChunk)).toEqual([
        `prompt ${messageId}`,
        "chunk Live",
        "chunk More",
      ])
      expect(seen.filter((item) => item === "state idle")).toHaveLength(1)
      expect(seen.at(-1)).toBe("state idle")
      test.close()
      other.close()
    }
  )

  it("shows a chunk streamed while a reopen reads history once, after it", async () => {
    const reading = gate()
    const page = gate()
    const test = await harness({
      providerIds: true,
      beforeHistory: () => {
        reading.release()
        return page.held
      },
    })
    await test.list()
    await liveTurn(test, [test])

    const from = test.recorder.entries.length
    const reopened = open(test, { replayFrom: { type: "start" } })
    await reading.held
    chunk(test.sources[0], "During")
    // The chunk reaches every live subscriber before the page returns.
    await settled()
    page.release()
    await reopened
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await test.recorder.wait(endedTurn, "the turn to end")

    const seen = flow(test.recorder, SESSION, from)
    const during = seen.filter((item) => item.includes("During"))
    expect(during).toHaveLength(1)
    expect(seen.indexOf(during[0] ?? "")).toBeGreaterThan(
      seen.indexOf("history message-1")
    )
    test.close()
  })

  it("still ends a turn cancelled when it is reopened after an acknowledged Stop", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await liveTurn(test, [test])
    await test.agent.notify(methods.agent.session.cancel, {
      sessionId: SESSION,
    })
    await test.recorder.wait(
      said('"execution":"stopping"'),
      'an update carrying "execution":"stopping"'
    )

    const from = test.recorder.entries.length
    await open(test, { replayFrom: { type: "start" } })
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    const ended = await test.recorder.wait(
      (entry) =>
        test.recorder.entries.indexOf(entry) >= from &&
        JSON.stringify(entry.params).includes('"state":"idle"'),
      'an update carrying "state":"idle"'
    )

    expect(ended.params).toMatchObject({
      update: { state: "idle", stopReason: "cancelled" },
    })
    test.close()
  })

  it("streams each chunk once to a browser that reopens twice in a row", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await liveTurn(test, [other])

    const first = other.recorder.entries.length
    await open(other, { replayFrom: { type: "start" } })
    await other.recorder.wait(
      (entry) =>
        other.recorder.entries.indexOf(entry) >= first && said("Live")(entry),
      'a fresh update carrying "Live"'
    )
    const from = other.recorder.entries.length
    await open(other, { replayFrom: { type: "start" } })
    chunk(test.sources[0], "More")
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await other.recorder.wait(endedTurn, "the turn to end")

    expect(
      flow(other.recorder, SESSION, from).filter((item) =>
        item.startsWith("chunk")
      )
    ).toEqual(["chunk Live", "chunk More"])
    test.close()
    other.close()
  })

  it("keeps streaming a reopen whose turn outgrew its journal", async () => {
    const test = await harness({ providerIds: true, maxReplayEvents: 2 })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await liveTurn(test, [other])
    // A third event outgrows the journal, so the turn's start is gone.
    chunk(test.sources[0], "Aside", "assistant-2")
    await other.recorder.wait(said("Aside"), "an update carrying Aside")

    const from = other.recorder.entries.length
    await open(other, { replayFrom: { type: "start" } })
    chunk(test.sources[0], "More", "assistant-2")
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await other.recorder.wait(endedTurn, "the turn to end")

    const seen = other.recorder.entries.slice(from)
    expect(JSON.stringify(seen)).not.toContain("AOS_RESET_REQUIRED")
    expect(
      flow(other.recorder, SESSION, from).filter((item) =>
        item.startsWith("chunk")
      )
    ).toEqual(["chunk More"])
    test.close()
    other.close()
  })

  it("replays only history to a browser that joins after the turn ended", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    reply(test.sources[0], "Done")
    await test.recorder.wait(endedTurn, "the turn to end")
    await waitFor(() => expect(test.coordinator.state(test.scope)).toBe("idle"))

    const other = await test.connect("connection-2")
    await other.list()
    await open(other, { replayFrom: { type: "start" } })

    expect(flow(other.recorder)).toEqual(["history message-1", "state idle"])
    test.close()
    other.close()
  })

  it("brings a resume held on its model read into a turn that started meanwhile", async () => {
    const models = gate()
    const test = await harness({
      providerIds: true,
      beforeModels: () => models.held,
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    const resumed = other.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    await waitFor(() =>
      expect(test.logged()).toContainEqual(
        expect.objectContaining({ connectionId: "connection-2" })
      )
    )

    const messageId = await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [other])
    models.release()
    await resumed

    const seen = flow(other.recorder)
    expect(seen.slice(0, 3)).toEqual([
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
    ])
    expect(seen.filter((item) => item.startsWith("prompt"))).toHaveLength(1)
    test.close()
    other.close()
  })

  it("streams each event once to a browser that follows twice at once", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())

    const other = await test.connect("connection-2")
    await other.list()
    await Promise.all([open(other), open(other)])
    await replyWhileWatched(test.sources[0], "Done", [other, test])

    const seen = flow(other.recorder)
    expect(seen.filter((item) => item === "chunk Done")).toHaveLength(1)
    expect(seen.filter((item) => item.startsWith("prompt"))).toHaveLength(1)
    expect(
      flow(test.recorder).filter((item) => item === "chunk Done")
    ).toHaveLength(1)
    test.close()
    other.close()
  })

  it("reports no running state ahead of the stream when a draft's resume races its prompt", async () => {
    const models = gate()
    let hold = false
    const test = await harness({
      providerIds: true,
      beforeModels: () => (hold ? models.held : Promise.resolve()),
    })
    await test.create()
    hold = true
    const resumed = test.agent.request(methods.agent.session.resume, {
      sessionId: CREATED,
      cwd: "/",
    })
    const messageId = await prompt(test, "Summarize", CREATED)
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    models.release()
    await resumed
    await settled()

    expect(flow(test.recorder, CREATED)).toEqual([`prompt ${messageId}`])
    reply(test.sources[0], "Done")
    await test.recorder.wait(endedTurn, "the turn to end")
    expect(flow(test.recorder, CREATED)).toEqual([
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
      "state idle",
    ])
    test.close()
  })

  it("shows the sender its own prompt once after session/new", async () => {
    const test = await harness({ providerIds: true })
    await test.create()

    const messageId = await prompt(test, "Summarize", CREATED)
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    reply(test.sources[0], "Done")
    await test.recorder.wait(endedTurn, "the turn to end")

    expect(flow(test.recorder, CREATED)).toEqual([
      `prompt ${messageId}`,
      "state running",
      "chunk Done",
      "state idle",
    ])
    test.close()
  })

  it("leaves another Session the same browser has open untouched", async () => {
    const test = await harness({
      providerIds: true,
      rows: [sessionRow(), sessionRow({ id: "session-2" })],
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await open(other, { sessionId: "session-2" })
    const from = other.recorder.entries.length

    await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [other])

    expect(flow(other.recorder, "session-2", from)).toEqual([])
    expect(prompts(other.recorder)).toHaveLength(1)
    test.close()
    other.close()
  })

  it("streams a turn the runtime started by itself to every open browser", async () => {
    const watchers: ServerTurnWatcher[] = []
    const background = new EventSource()
    let started = false
    const test = await harness({
      providerIds: true,
      watch: (_scope, watcher) => {
        watchers.push(watcher)
        return () => undefined
      },
      discover: async () =>
        started
          ? { handle: background, state: "running", fromStart: true }
          : undefined,
    })
    await test.list()
    await open(test)
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    // An earlier turn of this proxy's own, as a Session that ran one has.
    await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [other, test])
    test.sources[0]?.finish()
    await waitFor(() => expect(test.coordinator.state(test.scope)).toBe("idle"))
    const fromTest = test.recorder.entries.length
    const fromOther = other.recorder.entries.length

    started = true
    background.emit(turnStarted())
    chunk(background, "Background")
    watchers[0]!.onTurn()
    for (const browser of [test, other])
      await browser.recorder.wait(
        said("Background"),
        "an update carrying Background"
      )
    background.emit({ kind: TurnEventKind.TurnEnded })
    for (const browser of [test, other])
      await browser.recorder.wait(
        (entry) => entry.method === AOS_METHODS.notify.sessionInvalidated,
        "the Session invalidation"
      )

    const turn = ["state running", "chunk Background", "state idle"]
    expect(flow(test.recorder, SESSION, fromTest)).toEqual(turn)
    expect(flow(other.recorder, SESSION, fromOther)).toEqual(turn)
    expect(watchers).toHaveLength(1)
    test.close()
    other.close()
  })

  it("asks a browser shown a prompt to reload when its turn ended first", async () => {
    const test = await harness({
      providerIds: true,
      // The provider runs the whole turn before its admission even returns.
      onStart: (source) => {
        reply(source, "Instant")
        source.finish()
      },
    })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)

    await prompt(test, "Summarize")
    const invalidated = await other.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.sessionInvalidated,
      "the Session invalidation"
    )

    expect(invalidated.params).toEqual({ sessionId: SESSION })
    expect(prompts(other.recorder)).toHaveLength(1)
    test.close()
    other.close()
  })

  it("sends nothing to a browser that closed the Session", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    await other.agent.request(methods.agent.session.close, {
      sessionId: SESSION,
    })
    const from = other.recorder.entries.length

    await prompt(test, "Summarize")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    reply(test.sources[0], "Done")
    await test.recorder.wait(endedTurn, "the turn to end")
    await settled()

    expect(other.recorder.entries.slice(from)).toEqual([])
    test.close()
    other.close()
  })
})

/**
 * A turn the runtime started by itself at `startedAt`, adopted as it is read
 * from its start.
 */
function adopted(handle: EventSource, startedAt = Date.now()) {
  return { handle, state: "running" as const, fromStart: true, startedAt }
}

/** One stored row of a turn, dated `createdAt`. */
function storedRow(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: string
): SessionHistoryResponse["messages"][number] {
  return { id, role, content: [{ type: "text", text }], createdAt }
}

/** A browser that reloads the Session after its only open tab closed. */
async function reloadAlone(test: Awaited<ReturnType<typeof harness>>) {
  test.close()
  await settled()
  const reloaded = await test.connect("connection-2")
  await reloaded.list()
  await open(reloaded, { replayFrom: { type: "start" } })
  return reloaded
}

describe("Reloading a running turn", () => {
  it("shows a lone tab's reload the turn once, from its stream", async () => {
    const test = await harness({ providerIds: true, history: storedLiveTurn() })
    await test.list()
    await liveTurn(test, [test])

    const reloaded = await reloadAlone(test)
    chunk(test.sources[0], "More")
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await reloaded.recorder.wait(endedTurn, "the turn to end")

    expect(prompts(reloaded.recorder)).toEqual([])
    expect(withoutStates(flow(reloaded.recorder))).toEqual([
      "history user-1",
      "chunk Live",
      "chunk More",
    ])
    reloaded.close()
  })

  it("shows a reload a turn the runtime started by itself once", async () => {
    const watchers: ServerTurnWatcher[] = []
    const background = new EventSource()
    // The turn stored rows before this proxy adopted it.
    const startedAt = Date.now() - 60_000
    const turns = [adopted(background, startedAt)]
    const test = await harness({
      providerIds: true,
      history: storedLiveTurn(new Date(startedAt + 1_000).toISOString()),
      watch: (_scope, watcher) => {
        watchers.push(watcher)
        return () => undefined
      },
      discover: async () => turns.shift(),
    })
    await test.list()
    await open(test)
    background.emit(turnStarted())
    chunk(background, "Live")
    watchers[0]!.onTurn()
    await test.recorder.wait(said("Live"), "an update carrying Live")

    const reloaded = await reloadAlone(test)
    chunk(background, "More")
    background.emit({ kind: TurnEventKind.TurnEnded })
    await reloaded.recorder.wait(endedTurn, "the turn to end")

    expect(withoutStates(flow(reloaded.recorder))).toEqual([
      "history user-1",
      "chunk Live",
      "chunk More",
    ])
    reloaded.close()
  })

  it("resets a reload of a turn the runtime started at a time it does not report", async () => {
    const watchers: ServerTurnWatcher[] = []
    const background = new EventSource()
    const turns = [
      { handle: background, state: "running" as const, fromStart: true },
    ]
    const test = await harness({
      providerIds: true,
      history: storedLiveTurn(),
      watch: (_scope, watcher) => {
        watchers.push(watcher)
        return () => undefined
      },
      discover: async () => turns.shift(),
    })
    await test.list()
    await open(test)
    background.emit(turnStarted())
    chunk(background, "Live")
    watchers[0]!.onTurn()
    await test.recorder.wait(said("Live"), "an update carrying Live")

    const reloaded = await reloadAlone(test)
    await reloaded.recorder.wait(
      said("AOS_RESET_REQUIRED"),
      "an update carrying AOS_RESET_REQUIRED"
    )
    await settled()

    expect(withoutStates(flow(reloaded.recorder))).toEqual([
      "history user-1",
      "history assistant-0",
    ])
    reloaded.close()
  })

  it("shows a reload a turn an answered question resumed once", async () => {
    const asked = new Date(Date.now() - 60_000).toISOString()
    const test = await harness({
      providerIds: true,
      history: [
        ...storedLiveTurn(asked),
        storedRow(
          "assistant-2",
          "assistant",
          "Resumed",
          new Date().toISOString()
        ),
      ],
    })
    await test.list()
    await liveTurn(test, [test])
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    test.sources[1]?.emit(turnStarted())
    chunk(test.sources[1], "Resumed")
    await test.recorder.wait(said("Resumed"), "an update carrying Resumed")

    const reloaded = await reloadAlone(test)
    chunk(test.sources[1], "More")
    test.sources[1]?.emit({ kind: TurnEventKind.TurnEnded })
    await reloaded.recorder.wait(endedTurn, "the turn to end")

    expect(withoutStates(flow(reloaded.recorder))).toEqual([
      "history user-1",
      "history assistant-0",
      "chunk Resumed",
      "chunk More",
    ])
    reloaded.close()
  })

  it("resets a reload whose page cannot be cut where the turn began", async () => {
    const test = await harness({
      providerIds: true,
      history: storedLiveTurn(""),
    })
    await test.list()
    await liveTurn(test, [test])

    const reloaded = await reloadAlone(test)
    await reloaded.recorder.wait(
      said("AOS_RESET_REQUIRED"),
      "an update carrying AOS_RESET_REQUIRED"
    )
    await settled()

    expect(withoutStates(flow(reloaded.recorder))).toEqual([
      "history user-1",
      "history assistant-0",
    ])
    reloaded.close()
  })

  it("dates the replayed turn where it began, not when it is replayed", async () => {
    const test = await harness({ providerIds: true, history: storedLiveTurn() })
    await test.list()
    const admittedAt = Date.now() - 30_000
    const clock = vi.spyOn(Date, "now").mockReturnValue(admittedAt)
    try {
      await liveTurn(test, [test])
    } finally {
      clock.mockRestore()
    }

    const reloaded = await reloadAlone(test)
    await reloaded.recorder.wait(said("Live"), "an update carrying Live")

    const dated = updates(reloaded.recorder).flatMap((params) => {
      const { update } = params as {
        update: { state?: string; _meta?: unknown }
      }
      const meta = z
        .object({ aos: z.object({ at: z.string() }) })
        .safeParse(update._meta)
      return update.state === "running" && meta.success
        ? [meta.data.aos.at]
        : []
    })
    expect(dated).toEqual([new Date(admittedAt).toISOString()])
    reloaded.close()
  })

  it("shows each turn once to a reload that lands as the next adopted turn starts", async () => {
    const watchers: ServerTurnWatcher[] = []
    const first = new EventSource()
    const next = new EventSource()
    const turns = [adopted(first), adopted(next)]
    const earlier = new Date(Date.now() - 60_000).toISOString()
    const page: SessionHistoryResponse["messages"] = [
      storedRow("user-1", "user", "First", earlier),
      storedRow("assistant-1", "assistant", "First reply", earlier),
    ]
    const test = await harness({
      providerIds: true,
      history: page,
      watch: (_scope, watcher) => {
        watchers.push(watcher)
        return () => undefined
      },
      discover: async () => turns.shift(),
    })
    await test.list()
    await open(test)
    first.emit(turnStarted())
    chunk(first, "First reply")
    watchers[0]!.onTurn()
    await test.recorder.wait(
      said("First reply"),
      "an update carrying First reply"
    )
    const firstTurn = test.coordinator.snapshot(test.scope).turnId

    // The runtime starts the next turn as the first one ends.
    const now = new Date().toISOString()
    page.push(
      storedRow("user-2", "user", "Next", now),
      storedRow("assistant-2", "assistant", "Next reply", now)
    )
    first.emit({ kind: TurnEventKind.TurnEnded })
    await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.sessionInvalidated,
      "the Session invalidation"
    )
    await waitFor(() =>
      expect(test.coordinator.replayStart(test.scope)?.turnId).not.toBe(
        firstTurn
      )
    )
    next.emit(turnStarted())
    chunk(next, "Next reply")

    // The reload the first turn's end asked for.
    const from = test.recorder.entries.length
    await open(test, { replayFrom: { type: "start" } })
    chunk(next, "Done")
    next.emit({ kind: TurnEventKind.TurnEnded })
    await test.recorder.wait(
      () => flow(test.recorder, SESSION, from).includes("state idle"),
      "the reloaded turn to settle idle"
    )

    expect(withoutStates(flow(test.recorder, SESSION, from))).toEqual([
      "history user-1",
      "history assistant-1",
      "history user-2",
      "chunk Next reply",
      "chunk Done",
    ])
    test.close()
  })
})

/** A Session of `count` messages, oldest first, alternating prompt and reply. */
function conversation(count: number): SessionHistoryResponse["messages"] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `Message ${index}` }],
    createdAt: NOW,
  }))
}

const cursorOf = (offset: number) =>
  Buffer.from(String(offset)).toString("base64url")

const HistoryReplySchema = z.object({
  _meta: z.object({ aos: z.object({ history: AosHistoryCursorSchema }) }),
})

/** Reads the page older than `cursor`, as a browser scrolling back does. */
function older(
  browser: Browser,
  cursor: string,
  sessionId = SESSION,
  replayFrom: Record<string, unknown> = { type: AOS_REPLAY_BEFORE, cursor }
) {
  return browser.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/",
    replayFrom: replayFrom as ResumeSessionRequest["replayFrom"],
  })
}

type SentUpdate = { messageId?: string; _meta?: Record<string, unknown> }

/** Every update one browser received since `from`. */
function pageUpdates(recorder: Recorder, from: number) {
  return recorder.entries
    .slice(from)
    .filter(({ method }) => method === methods.client.session.update)
    .map(({ params }) => (params as { update: SentUpdate }).update)
}

const pageTag = (update: SentUpdate) =>
  (update._meta?.[AOS_META_KEY] as { historyPage?: unknown } | undefined)
    ?.historyPage

const invalidParams = { code: invalidRequest().code }

describe("History pages", () => {
  it("gives a replaying resume the cursor of the next older page", async () => {
    const test = await harness({ transcript: conversation(1_200) })
    await test.list()

    const replayed = await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
    })
    const attached = await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })

    expect(HistoryReplySchema.parse(replayed)._meta.aos.history).toEqual({
      nextCursor: cursorOf(500),
    })
    expect(attached._meta?.[AOS_META_KEY]).not.toHaveProperty("history")
    test.close()
  })

  it("replays the whole Session from the start to a client that does not page history", async () => {
    const test = await harness({
      transcript: conversation(1_200),
      pagesHistory: false,
    })
    await test.list()
    const from = test.recorder.entries.length

    const replayed = await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
    })

    expect(HistoryReplySchema.parse(replayed)._meta.aos.history).toEqual({})
    expect(
      pageUpdates(test.recorder, from).map((update) => update.messageId)
    ).toEqual(conversation(1_200).map(({ id }) => id))
    test.close()
  })

  it("replays a message once when a turn stored during the replay shifts its page", async () => {
    const transcript = conversation(1_200)
    let reads = 0
    const test = await harness({
      transcript,
      pagesHistory: false,
      beforeHistory: async () => {
        // Two rows land between the newest page and the one before it.
        reads += 1
        if (reads === 2)
          transcript.push(
            ...conversation(1_202)
              .slice(1_200)
              .map((message) => ({ ...message, id: `late-${message.id}` }))
          )
      },
    })
    await test.list()
    reads = 0
    const from = test.recorder.entries.length

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
      replayFrom: { type: "start" },
    })

    expect(
      pageUpdates(test.recorder, from).map((update) => update.messageId)
    ).toEqual(conversation(1_200).map(({ id }) => id))
    test.close()
  })

  it("sends each older page as tagged updates before its reply, one per message", async () => {
    const test = await harness({ transcript: conversation(1_200) })
    await test.list()
    await open(test, { replayFrom: { type: "start" } })
    await settled()
    const from = test.recorder.entries.length

    const page = await older(test, cursorOf(500))

    const sent = pageUpdates(test.recorder, from)
    expect(page).toEqual({
      _meta: { [AOS_META_KEY]: { history: { nextCursor: cursorOf(1_000) } } },
    })
    expect(test.history).toHaveBeenLastCalledWith(AGENT, SESSION, 500, 500)
    expect(sent.map((update) => update.messageId)).toEqual(
      conversation(1_200)
        .slice(200, 700)
        .map(({ id }) => id)
    )
    for (const update of sent)
      expect(update._meta).toEqual({
        [AOS_META_KEY]: { historyPage: { cursor: cursorOf(500) } },
      })
    expect(test.logged()).toContainEqual(
      expect.objectContaining({
        event: "acp.history.page",
        sessionId: SESSION,
        offset: 500,
        count: 500,
      })
    )

    const last = test.recorder.entries.length
    const oldest = await older(test, cursorOf(1_000))

    expect(oldest).toEqual({ _meta: { [AOS_META_KEY]: { history: {} } } })
    expect(pageUpdates(test.recorder, last)).toHaveLength(200)
    test.close()
  })

  it("reads a page without rejoining, following, or reporting the Session", async () => {
    const test = await harness({ transcript: conversation(1_200) })
    await test.list()
    await open(test, { replayFrom: { type: "start" } })
    await settled()
    const from = test.recorder.entries.length

    await older(test, cursorOf(500))
    await settled()

    expect(test.recorder.entries.slice(from)).toHaveLength(500)
    expect(pageUpdates(test.recorder, from).every(pageTag)).toBe(true)
    await liveTurn(test, [test])
    const live = await test.recorder.wait(
      said("Live"),
      "an update carrying Live"
    )
    expect(pageTag((live.params as { update: SentUpdate }).update)).toBe(
      undefined
    )
    expect(flow(test.recorder, SESSION, from).filter(isPromptOrChunk)).toEqual([
      expect.stringMatching(/^prompt /u),
      "chunk Live",
    ])
    test.close()
  })

  it("replays a page as the start replay translates it, without its plan", async () => {
    const special: SessionHistoryResponse["messages"] = [
      {
        id: "user-a",
        role: "user",
        content: [{ type: "text", text: "Try it" }],
        createdAt: NOW,
      },
      {
        id: "assistant-a",
        role: "assistant",
        content: [{ type: "text", text: "Partial" }],
        createdAt: NOW,
        status: {
          type: "incomplete",
          reason: "error",
          error: "Provider failed",
        },
      },
      {
        id: "plan-a",
        role: "activity",
        activityType: "PLAN",
        content: {
          todos: [{ id: "todo-1", label: "Check", status: "pending" }],
        },
      },
    ]
    const transcript = [...special, ...conversation(500)]
    const test = await harness({ transcript, translateHistory })
    await test.list()
    await open(test, { replayFrom: { type: "start" } })
    await settled()
    const from = test.recorder.entries.length

    await older(test, cursorOf(500))

    const expected = translateHistory(
      {
        sessionId: SESSION,
        messages: special,
        total: transcript.length,
        limit: 500,
        offset: 500,
        nextOffset: transcript.length,
      },
      "operator"
    ).flatMap((outbound) =>
      outbound.kind === "update" &&
      outbound.update.sessionUpdate !== "plan_update"
        ? [outbound.update]
        : []
    )
    const sent = pageUpdates(test.recorder, from)
    expect(sent).toEqual(
      expected.map((update) => ({
        ...update,
        _meta: {
          ...update._meta,
          [AOS_META_KEY]: {
            ...(update._meta?.[AOS_META_KEY] as object | undefined),
            historyPage: { cursor: cursorOf(500) },
          },
        },
      }))
    )
    expect(JSON.stringify(sent)).toContain("Provider failed")
    expect(JSON.stringify(sent)).not.toContain("plan_update")
    test.close()
  })

  it("serves a page only to a connection that attached the Session", async () => {
    const test = await harness({ transcript: conversation(1_200) })
    await test.list()

    await expect(older(test, cursorOf(500))).rejects.toMatchObject({
      code: AOS_JSONRPC_ERRORS.notFound,
    })
    await test.create()
    await expect(older(test, cursorOf(500), CREATED)).resolves.toEqual({
      _meta: { [AOS_META_KEY]: { history: { nextCursor: cursorOf(1_000) } } },
    })
    await open(test)
    await test.agent.request(methods.agent.session.close, {
      sessionId: SESSION,
    })
    await expect(older(test, cursorOf(500))).rejects.toMatchObject({
      code: AOS_JSONRPC_ERRORS.notFound,
    })
    test.close()
  })

  it("refuses a replay cursor it does not understand", async () => {
    const test = await harness({ transcript: conversation(1_200) })
    await test.list()
    await open(test, { replayFrom: { type: "start" } })
    const cursor = cursorOf(500)

    for (const replayFrom of [
      { type: AOS_REPLAY_BEFORE },
      { type: AOS_REPLAY_BEFORE, cursor: "" },
      { type: AOS_REPLAY_BEFORE, cursor, after: 1 },
      { type: AOS_REPLAY_BEFORE, cursor: 500 },
      { type: "_aos/after", cursor },
      { type: "future" },
    ])
      await expect(
        older(test, cursor, SESSION, replayFrom)
      ).rejects.toMatchObject(invalidParams)
    test.close()
  })

  it("reports history past the proxy's or the runtime's reach as truncated", async () => {
    const test = await harness({ transcript: conversation(100_600) })
    await test.list()
    await open(test)

    await expect(older(test, cursorOf(99_800))).resolves.toEqual({
      _meta: { [AOS_META_KEY]: { history: { truncated: true } } },
    })
    await expect(older(test, cursorOf(100_000))).rejects.toMatchObject(
      invalidParams
    )
    test.close()

    const cut = await harness({
      transcript: conversation(1_200),
      truncated: true,
    })
    await cut.list()
    await open(cut)
    await expect(older(cut, cursorOf(1_000))).resolves.toEqual({
      _meta: { [AOS_META_KEY]: { history: { truncated: true } } },
    })
    // A runtime at its reach may still count rows past it; no cursor leads there.
    cut.history.mockResolvedValueOnce({
      sessionId: SESSION,
      messages: conversation(100),
      total: 601,
      limit: 500,
      offset: 500,
      nextOffset: 600,
      truncated: true,
    })
    await expect(older(cut, cursorOf(500))).resolves.toEqual({
      _meta: { [AOS_META_KEY]: { history: { truncated: true } } },
    })
    cut.close()
  })

  it("reaches the beginning of a Session whose runtime estimated one more row", async () => {
    const test = await harness({ transcript: conversation(1_200) })
    await test.list()
    await open(test)
    // The previous page was full, so the runtime counted a row past it.
    test.history.mockResolvedValueOnce({
      sessionId: SESSION,
      messages: [],
      total: 500,
      limit: 500,
      offset: 500,
      nextOffset: 500,
    })

    await expect(older(test, cursorOf(500))).resolves.toEqual({
      _meta: { [AOS_META_KEY]: { history: {} } },
    })
    test.close()
  })

  it("sends a page of large messages one frame per message", async () => {
    const large = "x".repeat(900_000)
    const transcript = conversation(1_000).map((message, index) =>
      index < 505
        ? { ...message, content: [{ type: "text" as const, text: large }] }
        : message
    )
    const test = await harness({ transcript, translateHistory })
    await test.list()
    await open(test)
    await settled()
    const from = test.recorder.entries.length

    await older(test, cursorOf(500))

    const frames = test.recorder.entries
      .slice(from)
      .filter(({ method }) => method === methods.client.session.update)
      .map((entry) => Buffer.byteLength(JSON.stringify(entry)))
    expect(frames.length).toBeGreaterThanOrEqual(500)
    // The page as a whole is far past the socket's 4 MiB output limit.
    expect(frames.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(
      4 * 1_024 * 1_024
    )
    for (const bytes of frames) expect(bytes).toBeLessThan(1_000_000)
    test.close()
  })

  it("refuses a cursor it could not have issued for this Session", async () => {
    const test = await harness({ transcript: conversation(1_200) })
    await test.list()
    await open(test)
    const encoded = (text: string) => Buffer.from(text).toString("base64url")

    for (const cursor of [
      "not-a-cursor",
      `${cursorOf(500)}==`,
      encoded("5e2"),
      encoded("-500"),
      encoded("0"),
      cursorOf(5_000),
    ])
      await expect(older(test, cursor)).rejects.toMatchObject(invalidParams)
    test.close()
  })

  it("refuses a second page while one is in flight", async () => {
    const pending = gate()
    let hold = false
    const test = await harness({
      transcript: conversation(1_200),
      beforeHistory: () => (hold ? pending.held : Promise.resolve()),
    })
    await test.list()
    await open(test)
    hold = true

    const first = older(test, cursorOf(500))
    await waitFor(() => expect(test.history).toHaveBeenCalledTimes(1))
    await expect(older(test, cursorOf(500))).rejects.toMatchObject(
      invalidParams
    )
    pending.release()

    await expect(first).resolves.toMatchObject({
      _meta: { [AOS_META_KEY]: { history: { nextCursor: cursorOf(1_000) } } },
    })
    hold = false
    await expect(older(test, cursorOf(1_000))).resolves.toBeDefined()
    test.close()
  })

  it("cuts a turn streamed from its start off every older page it reaches", async () => {
    const watchers: ServerTurnWatcher[] = []
    const background = new EventSource()
    const startedAt = Date.now() - 60_000
    const at = (ms: number) => new Date(startedAt + ms).toISOString()
    const turns = [adopted(background, startedAt)]
    // The turn before ended within the cut's clock skew of this one's start,
    // and this one stored more rows than a page holds.
    const transcript = [
      ...conversation(601).map((message) => ({
        ...message,
        createdAt: at(-2_000),
      })),
      storedRow("live-prompt", "user", "Go", at(1_000)),
      ...Array.from({ length: 700 }, (_, index) =>
        storedRow(`live-${index}`, "assistant", `Step ${index}`, at(2_000))
      ),
    ]
    const test = await harness({
      providerIds: true,
      transcript,
      watch: (_scope, watcher) => {
        watchers.push(watcher)
        return () => undefined
      },
      discover: async () => turns.shift(),
    })
    await test.list()
    await open(test, { replayFrom: { type: "start" } })
    background.emit(turnStarted())
    chunk(background, "Live")
    watchers[0]!.onTurn()
    await test.recorder.wait(said("Live"), "an update carrying Live")

    /** The message ids of the page older than `offset`. */
    const pageIds = async (offset: number) => {
      const from = test.recorder.entries.length
      await older(test, cursorOf(offset))
      return pageUpdates(test.recorder, from).map(({ messageId }) => messageId)
    }
    const ids = (from: number, to: number) =>
      transcript.slice(from, to).map(({ id }) => id)
    expect(await pageIds(500)).toEqual(ids(302, 602))
    expect(await pageIds(1_000)).toEqual(ids(0, 302))
    test.close()
  })
})
