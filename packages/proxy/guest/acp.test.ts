// @vitest-environment node

import {
  client,
  methods,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"

import { INTERACTION_PROTOCOL } from "../../protocol"
import {
  ACP_PROTOCOL_VERSION,
  AOS_AUTH_METHOD_INVITE,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_META_KEY,
} from "../../protocol/acp"
import { createAosAcpAgent } from "../acp/agent"
import { createSessionRooms } from "../acp/session-rooms"
import {
  createGuestInvitationService,
  type GuestInvitationService,
} from "../auth/guest-invitation"
import { AttachmentStageRegistry } from "../core/attachment-stages"
import {
  PendingRequestKind,
  TurnEventKind,
  type PendingRequest,
  type TurnEvent,
} from "../core/events"
import type {
  RuntimeInstance,
  ServerTurnEngine,
  ServerTurnHandle,
  ServerRuntime,
} from "../core/runtime"
import { SessionCoordinator } from "../core/session-coordinator"
import { createSessionRows } from "../core/session-rows"
import { createGuestConnection } from "./acp"

const NOW = 1_700_000_000_000
const ORIGIN = "https://guest.example.test"
const RUNTIME_ID = "hermes-primary"
const AGENT = "interviewer"
const REF = "guest_ref"
const STORED = "stored-session"
const KEY = new Uint8Array(32).fill(7)
const INSTRUCTION = "Load the interview skill."
/** JSON-RPC reserves this code; the SDK's `methodNotFound` returns it. */
const METHOD_NOT_FOUND = -32601

const APPROVAL: PendingRequest = {
  requestId: "approval-1",
  kind: PendingRequestKind.Permission,
  message: "Delete the notes?",
  responseSchema: { type: "string", enum: ["once", "session", "always"] },
}

/** Provider capabilities that include everything a guest may not learn. */
const CAPABILITIES = {
  workspace: {
    slashCommands: {
      status: "available",
      scope: "attached-session",
      commands: [{ name: "plan", description: "Draft a plan" }],
    },
    models: {
      status: "available",
      scope: "attached-session",
      selection: "native-session",
      choices: "provider-reported",
    },
    context: {
      status: "available",
      scope: "attached-session",
      source: "provider-usage-or-estimate",
      breakdown: "provider-categories",
    },
    todos: { status: "unavailable", reason: "not-supported" },
    activity: { status: "unavailable", reason: "not-supported" },
  },
  interactions: {
    steering: {
      status: "available",
      scope: "active-turn",
      semantics: "visible-user-message",
      input: "text",
      fallback: "provider-queue",
    },
    approvals: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "turn",
      choices: [
        { value: "once", scope: "request" },
        { value: "session", scope: "session" },
        { value: "always", scope: "agent" },
      ],
      maxPending: 1,
    },
    questions: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "turn",
      answerModes: ["single", "multiple", "free-text"],
      cancellation: "native-empty-answer",
      maxQuestions: 10,
      maxChoicesPerQuestion: 10,
      maxAnswerValuesPerQuestion: 10,
      maxStringBytes: 2_000,
    },
    reactions: { status: "unavailable", reason: "not-supported" },
  },
  content: {
    attachments: { status: "unavailable", reason: "not-supported" },
    artifacts: { status: "unavailable", reason: "not-supported" },
    mcpApps: { status: "unavailable", reason: "not-supported" },
    transcription: { status: "unavailable", reason: "not-supported" },
    speech: { status: "unavailable", reason: "not-supported" },
  },
}

/** A file under the operator's home: tool data carries it to operators only. */
const OPERATOR_PATH = "/home/operator/project/notes.md"
const OPERATOR_DIFF = {
  changes: [{ operation: "modify" as const, path: OPERATOR_PATH }],
  patch: `--- a${OPERATOR_PATH}\n+++ b${OPERATOR_PATH}\n-old\n+new\n`,
}

/** One published artifact, as the Hermes adapter emits it live and stored. */
const ARTIFACT = {
  id: "art-1",
  filename: "notes.md",
  mimeType: "text/markdown",
  source: { type: "provider" as const, reference: "art-1" },
}

/** A tool that declares an MCP App view, which a guest sees as its card. */
const APP_TOOL = "mcp__excalidraw__create_view"

/** The one tool update a guest receives for an App: its card, nothing more. */
function appCards(recorder: ReturnType<typeof createRecorder>) {
  return updates(recorder).flatMap(({ update }) =>
    update.sessionUpdate === "tool_call_update" ? [update] : []
  )
}

/** A stored conversation whose reasoning, edit, and setup turn are operator-only. */
const HISTORY = {
  sessionId: STORED,
  messages: [
    {
      id: "user-0",
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            v: 1,
            type: "aos.guest.first-turn",
            instruction: INSTRUCTION,
          }),
        },
      ],
      createdAt: "2026-09-15T00:00:00.000Z",
    },
    {
      id: "assistant-1",
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Safe answer" },
        { type: "reasoning" as const, text: "private reasoning" },
        {
          type: "tool-call" as const,
          toolCallId: "stored-edit",
          toolName: "patch",
          args: { path: OPERATOR_PATH },
          argsText: JSON.stringify({ path: OPERATOR_PATH }),
          result: "ok",
          kind: "edit" as const,
          locations: [{ path: OPERATOR_PATH }],
          diffs: [OPERATOR_DIFF],
        },
        { type: "data" as const, name: "aos.artifact", data: ARTIFACT },
        {
          type: "tool-call" as const,
          toolCallId: "stored-app",
          toolName: APP_TOOL,
          args: { title: "private app input" },
          argsText: '{"title":"private app input"}',
          result: { content: [{ type: "text", text: "private app output" }] },
          app: true as const,
        },
        {
          type: "tool-call" as const,
          toolCallId: "stored-read",
          toolName: "read_file",
          args: { path: "/private" },
          argsText: '{"path":"/private"}',
        },
      ],
      createdAt: "2026-09-15T00:00:01.000Z",
    },
  ],
  total: 2,
  limit: 500,
  offset: 0,
  nextOffset: 2,
}

function invitationService() {
  return createGuestInvitationService({
    issuer: "aos-invite",
    audience: "aos-guest",
    deploymentId: "deployment-a",
    runtimeId: RUNTIME_ID,
    keys: [{ id: "current", secret: KEY }],
    now: () => NOW,
    ttlSeconds: 259_200,
  })
}

async function invite(service: GuestInvitationService) {
  return (
    await service.issue({
      agentId: AGENT,
      ref: REF,
      firstTurn: { instruction: INSTRUCTION },
    })
  ).token
}

function terminalHandle(events: readonly TurnEvent[]): ServerTurnHandle {
  return {
    events: (async function* () {
      yield* events
    })(),
    settled: Promise.resolve(),
    stop: vi.fn(async () => "idle" as const),
    recoveryPosition: () => ({ epoch: "native", lastSeen: events.length }),
  }
}

/** A run the provider keeps open until Stop releases it. */
function openHandle(events: readonly TurnEvent[]): ServerTurnHandle {
  let release = () => undefined as void
  const settled = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  return {
    events: (async function* () {
      yield* events
      await settled
    })(),
    settled,
    stop: vi.fn(async () => {
      release()
      return "stopping" as const
    }),
    recoveryPosition: () => ({ epoch: "native", lastSeen: events.length }),
  }
}

/** One run segment whose reasoning, file edit, App, and prose all reach the proxy. */
const RUN_EVENTS: TurnEvent[] = [
  { kind: TurnEventKind.TurnStarted },
  {
    kind: TurnEventKind.ThoughtChunk,
    messageId: "assistant-native",
    text: "private reasoning",
  },
  {
    kind: TurnEventKind.ToolCallStarted,
    toolCallId: "tool-1",
    title: "read_file",
    parentMessageId: "assistant-native",
    locations: [{ path: OPERATOR_PATH }],
  },
  {
    kind: TurnEventKind.ToolCallFinished,
    toolCallId: "tool-1",
    output: "ok",
    failed: false,
    diffs: [OPERATOR_DIFF],
  },
  {
    kind: TurnEventKind.ToolCallStarted,
    toolCallId: "live-app",
    title: APP_TOOL,
  },
  {
    kind: TurnEventKind.ToolCallInputChunk,
    toolCallId: "live-app",
    delta: '{"title":"private app input"}',
  },
  { kind: TurnEventKind.ToolCallInputEnded, toolCallId: "live-app" },
  {
    kind: TurnEventKind.ToolCallFinished,
    toolCallId: "live-app",
    output: "private app output",
    failed: false,
    app: true,
  },
  {
    kind: TurnEventKind.MessageChunk,
    messageId: "assistant-native",
    text: "Guest-visible answer",
  },
  { kind: TurnEventKind.ArtifactPublished, artifact: ARTIFACT },
  { kind: TurnEventKind.TurnEnded },
]

const REQUEST_EVENTS: TurnEvent[] = [
  { kind: TurnEventKind.TurnStarted },
  { kind: TurnEventKind.TurnRequiresAction, requests: [APPROVAL] },
]

type Recorded = { method: string; params: unknown }

function createRecorder() {
  const entries: Recorded[] = []
  const waiters = new Set<() => void>()
  return {
    entries,
    of(method: string) {
      return entries.filter((entry) => entry.method === method)
    },
    add(entry: Recorded) {
      entries.push(entry)
      for (const resolve of [...waiters]) resolve()
    },
    async wait(predicate: (entry: Recorded) => boolean) {
      for (;;) {
        const found = entries.find(predicate)
        if (found) return found
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiters.delete(wake)
            resolve()
          }
          waiters.add(wake)
        })
      }
    },
  }
}

const unsupported = () => {
  throw new Error("The guest ACP lane does not reach this operation")
}

type HarnessOptions = {
  /** The invited Session already exists; a fresh invitation creates nothing. */
  existing?: boolean
  handle?: () => ServerTurnHandle
  /** The guest's answer; `signal` aborts as the proxy withdraws the request. */
  permission?: (
    params: unknown,
    signal: AbortSignal
  ) => Promise<RequestPermissionResponse>
}

function harness(options: HarnessOptions = {}) {
  const handles: ServerTurnHandle[] = []
  const start = vi.fn(async (): Promise<ServerTurnHandle> => {
    const handle = options.handle
      ? options.handle()
      : terminalHandle(RUN_EVENTS)
    handles.push(handle)
    return handle
  })
  const engine: ServerTurnEngine = {
    start,
    recover: vi.fn(unsupported),
    discover: vi.fn(async () => undefined),
  }
  const coordinator = new SessionCoordinator({
    engine,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 4,
    maxSubscriberEvents: 64,
    maxSubscriberBytes: 256 * 1_024,
    maxReplayEvents: 64,
    maxReplayBytes: 256 * 1_024,
  })
  const resolveInvitedSession = vi.fn(
    async (_agentId: string, _ref: string, create?: object) =>
      options.existing || create
        ? { sessionId: STORED, created: !options.existing }
        : undefined
  )
  const updateSession = vi.fn(async () => undefined)
  const deleteSession = vi.fn(async () => undefined)
  const runtimeInfo = vi.fn(unsupported)
  const workspaceCapabilities = vi.fn(async () => CAPABILITIES)
  const history = vi.fn(async () => HISTORY)
  const listAllSessions = vi.fn(async (limit: number, offset: number) => ({
    sessions: [],
    total: 0,
    limit,
    offset,
  }))
  const runtime: ServerRuntime = {
    turns: engine,
    resolveInvitedSession,
    // A guest addresses its conversation by reference; no public id resolves.
    resolveSessionId: () => undefined,
    publicError: () => undefined,
    authState: unsupported,
    runtimeInfo,
    listAgents: unsupported,
    updateAgentVisibility: unsupported,
    listAllSessions,
    listSessions: unsupported,
    history,
    getSession: async () => ({
      id: STORED,
      agentId: AGENT,
      title: "Operator-owned title",
      archived: false,
      updatedAt: "2026-09-15T00:00:00.000Z",
      status: "idle",
    }),
    createSession: unsupported,
    updateSession,
    deleteSession,
    workspaceCapabilities,
    models: unsupported,
    updateModel: unsupported,
    context: unsupported,
    subscribeSessionInvalidation: unsupported,
    subscribeCatalogChanges: unsupported,
    stageAttachments: unsupported,
    artifact: unsupported,
    transcribe: unsupported,
    speak: unsupported,
  }
  const runtimeInstance: RuntimeInstance = {
    id: RUNTIME_ID,
    runtime,
    sessions: coordinator,
    close: async () => undefined,
  }
  const scheduled: Array<{ delayMs: number; task: () => void }> = []
  const clock = { now: NOW }
  const invitations = invitationService()
  const context = createGuestConnection(
    {
      publicOrigin: ORIGIN,
      runtimeInstance,
      invitations,
      attachmentStages: new AttachmentStageRegistry(),
      rooms: createSessionRooms({
        snapshot: (scope) => coordinator.snapshot(scope),
      }),
      now: () => clock.now,
      schedule: (delayMs, task) => {
        scheduled.push({ delayMs, task })
        return scheduled.length
      },
      cancel: () => undefined,
    },
    createSessionRows({ now: () => NOW }),
    "connection-1"
  )

  const recorder = createRecorder()
  const clientApp = client({ name: "aos-guest-browser" })
    .onNotification(methods.client.session.update, ({ params }) => {
      recorder.add({ method: methods.client.session.update, params })
    })
    .onRequest(
      methods.client.session.requestPermission,
      async ({ params, signal }) => {
        recorder.add({
          method: methods.client.session.requestPermission,
          params,
        })
        return (
          (await options.permission?.(params, signal)) ?? {
            outcome: { outcome: "selected", optionId: "once" },
          }
        )
      }
    )
  for (const method of Object.values(AOS_METHODS.notify))
    clientApp.onNotification(
      method,
      (params) => params,
      ({ params }) => {
        recorder.add({ method, params })
      }
    )
  const connection = clientApp.connect(createAosAcpAgent(context))

  return {
    agent: connection.agent,
    closed: connection.closed,
    close: () => connection.close(),
    recorder,
    scheduled,
    clock,
    invitations,
    policy: context.guest,
    coordinator,
    start,
    handles,
    history,
    updateSession,
    deleteSession,
    runtimeInfo,
    resolveInvitedSession,
    listAllSessions,
    initialize: () =>
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        info: { name: "aos-guest-browser", version: "1" },
        capabilities: {},
      }),
    login: async (token: string) =>
      await connection.agent.request(methods.agent.auth.login, {
        methodId: AOS_AUTH_METHOD_INVITE,
        _meta: { [AOS_META_KEY]: { token } },
      }),
    resume: (sessionId: string, replay = false) =>
      connection.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd: "/",
        ...(replay ? { replayFrom: { type: "start" as const } } : {}),
      }),
    prompt: (text: string) =>
      connection.agent.request(methods.agent.session.prompt, {
        sessionId: REF,
        prompt: [{ type: "text" as const, text }],
      }),
  }
}

function updates(recorder: ReturnType<typeof createRecorder>) {
  return recorder.of(methods.client.session.update).map((entry) => entry.params)
}

describe("guest ACP lane", () => {
  it("advertises the invitation auth method and no workspace extensions", async () => {
    const test = harness()

    const initialize = await test.initialize()

    expect(initialize).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      capabilities: { session: { prompt: { image: {} } } },
      authMethods: [{ methodId: AOS_AUTH_METHOD_INVITE }],
      _meta: {
        [AOS_META_KEY]: {
          lane: "guest",
          extensions: {
            guestProjection: true,
            steer: false,
            agents: false,
            readState: false,
          },
        },
      },
    })
    expect(initialize.capabilities.session?.delete).toBeUndefined()
    // The deployment itself stays unnamed until an invitation is redeemed.
    expect(test.runtimeInfo).not.toHaveBeenCalled()
    test.close()
  })

  it("answers every method with authentication required before login", async () => {
    const test = harness({ existing: true })
    await test.initialize()
    const required = { code: AOS_JSONRPC_ERRORS.authenticationRequired }

    await expect(test.resume(REF)).rejects.toMatchObject(required)
    await expect(test.prompt("Hello")).rejects.toMatchObject(required)
    await expect(
      test.agent.request(methods.agent.session.list, {})
    ).rejects.toMatchObject(required)
    await expect(
      test.agent.request(methods.agent.session.new, { cwd: "/" })
    ).rejects.toMatchObject(required)
    await expect(
      test.agent.request(methods.agent.session.close, { sessionId: REF })
    ).rejects.toMatchObject(required)
    await expect(
      test.agent.request(AOS_METHODS.agents.list, undefined)
    ).rejects.toMatchObject(required)
    expect(test.resolveInvitedSession).not.toHaveBeenCalled()
    test.close()
  })

  it("refuses a token the invitation service cannot verify", async () => {
    const test = harness()
    await test.initialize()

    await expect(test.login("not-a-token")).rejects.toMatchObject({
      code: AOS_JSONRPC_ERRORS.authenticationRequired,
    })
    await expect(test.resume(REF)).rejects.toMatchObject({
      code: AOS_JSONRPC_ERRORS.authenticationRequired,
    })
    test.close()
  })

  it("resumes only the invited Session and projects its history", async () => {
    const test = harness({ existing: true })
    await test.initialize()
    await test.login(await invite(test.invitations))

    const resumed = await test.resume(REF, true)

    expect(resumed).toMatchObject({
      _meta: {
        [AOS_META_KEY]: {
          session: { agentId: AGENT, status: "idle", archived: false },
          execution: { status: "idle" },
        },
      },
    })
    // The operator's own Session title never travels to a guest.
    expect(JSON.stringify(resumed)).not.toContain("Operator-owned title")
    expect(resumed).toMatchObject({
      _meta: {
        [AOS_META_KEY]: {
          capabilities: {
            workspace: { models: { status: "unavailable" } },
            interactions: { steering: { status: "unavailable" } },
          },
        },
      },
    })
    expect(test.history).toHaveBeenCalledWith(AGENT, STORED, 500, 0)
    const replayed = JSON.stringify(updates(test.recorder))
    expect(replayed).toContain("Safe answer")
    expect(replayed).not.toContain("private reasoning")
    expect(replayed).not.toContain(OPERATOR_PATH)
    expect(replayed).not.toContain("+new")
    expect(appCards(test.recorder)).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "stored-app",
        title: APP_TOOL,
        name: APP_TOOL,
        status: "completed",
        _meta: {
          [AOS_META_KEY]: expect.objectContaining({ app: {} }),
        },
      },
    ])
    expect(replayed).not.toContain("private app")
    expect(replayed).not.toContain("/private")
    // The invitation's setup turn is not part of the guest conversation.
    expect(replayed).not.toContain(INSTRUCTION)
    await expect(test.resume("another-session")).rejects.toMatchObject({
      code: AOS_JSONRPC_ERRORS.notFound,
    })
    test.close()
  })

  it("projects another member's prompt the way its history projects a user turn", async () => {
    const test = harness()
    // One byte past the guest message text bound, which history drops too.
    const oversized = "x".repeat(16_385)
    expect(() => test.policy?.project.turn("Hello")).toThrow()
    await test.initialize()
    await test.login(await invite(test.invitations))

    expect(test.policy?.project.turn("Hello")).toBe("Hello")
    expect(test.policy?.project.turn(oversized)).toBeUndefined()
    const history = test.policy?.project.history({
      sessionId: REF,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "user-2",
          role: "user",
          content: [{ type: "text", text: oversized }],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 2,
      limit: 500,
      offset: 0,
      nextOffset: 0,
    })
    expect(history?.messages.map(({ content }) => content)).toEqual([
      [{ type: "text", text: "Hello" }],
    ])
    test.close()
  })

  it("gives an expired grant no copy of another member's prompt", async () => {
    const test = harness()
    await test.initialize()
    await test.login(await invite(test.invitations))

    test.clock.now = NOW + 259_200_000
    expect(test.policy?.project.turn("Hello")).toBeUndefined()
    test.close()
  })

  it("links a streamed artifact by its id alone", async () => {
    const test = harness({ existing: true })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF, true)
    await test.prompt("Show the notes")
    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("resource_link")
    )

    const links = updates(test.recorder).flatMap(({ update }) =>
      "content" in update &&
      !Array.isArray(update.content) &&
      update.content?.type === "resource_link"
        ? [update.content]
        : []
    )
    // The guest history projection keeps text alone, so only the live
    // publication links, and it names neither a route nor the stored Session.
    expect(links.map((link) => link.uri)).toEqual(["artifact://art-1"])
    expect(JSON.stringify(links)).not.toContain(STORED)
    test.close()
  })

  it("resumes a fresh invitation without creating or reading a Session", async () => {
    const test = harness()
    await test.initialize()
    await test.login(await invite(test.invitations))

    const resumed = await test.resume(REF, true)

    expect(resumed).toMatchObject({
      _meta: { [AOS_META_KEY]: { execution: { status: "idle" } } },
    })
    expect(test.resolveInvitedSession).toHaveBeenCalledWith(
      AGENT,
      REF,
      undefined
    )
    expect(test.resolveInvitedSession).not.toHaveBeenCalledWith(
      AGENT,
      REF,
      expect.anything()
    )
    expect(test.history).not.toHaveBeenCalled()
    expect(updates(test.recorder)).toEqual([])
    test.close()
  })

  it("refuses the methods an operator owns", async () => {
    const test = harness({ existing: true })
    await test.initialize()
    await test.login(await invite(test.invitations))
    const refused = { code: METHOD_NOT_FOUND }

    await expect(
      test.agent.request(methods.agent.session.new, { cwd: "/" })
    ).rejects.toMatchObject(refused)
    await expect(
      test.agent.request(methods.agent.session.list, {})
    ).rejects.toMatchObject(refused)
    await expect(
      test.agent.request(AOS_METHODS.session.steer, {
        sessionId: REF,
        requestId: "steer-1",
        text: "Wait",
      })
    ).rejects.toMatchObject(refused)
    await expect(
      test.agent.request(AOS_METHODS.session.update, {
        sessionId: REF,
        title: "Renamed",
      })
    ).rejects.toMatchObject(refused)
    await expect(
      test.agent.request(methods.agent.session.delete, { sessionId: REF })
    ).rejects.toMatchObject(refused)
    await expect(
      test.agent.request(methods.agent.session.setConfigOption, {
        sessionId: REF,
        configId: "model",
        type: "id",
        value: "opus",
      })
    ).rejects.toMatchObject(refused)
    expect(test.updateSession).not.toHaveBeenCalled()
    test.close()
  })

  it("carries the invitation's first turn and streams only guest-safe output", async () => {
    const test = harness()
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)

    await test.prompt("Start the interview")

    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("Guest-visible answer")
    )
    expect(test.resolveInvitedSession).toHaveBeenLastCalledWith(AGENT, REF, {
      firstTurnInstruction: INSTRUCTION,
    })
    const streamed = JSON.stringify(updates(test.recorder))
    expect(streamed).toContain("agent_message_chunk")
    expect(streamed).not.toContain("agent_thought_chunk")
    expect(appCards(test.recorder)).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "live-app",
        title: APP_TOOL,
        name: APP_TOOL,
        status: "completed",
        _meta: {
          [AOS_META_KEY]: expect.objectContaining({ app: {} }),
        },
      },
    ])
    expect(streamed).not.toContain("read_file")
    expect(streamed).not.toContain("private")
    expect(streamed).not.toContain(OPERATOR_PATH)
    expect(streamed).not.toContain("+new")
    test.close()
  })

  it("streams a failed turn without the location its provider detail names", async () => {
    const test = harness({
      handle: () =>
        terminalHandle([
          { kind: TurnEventKind.TurnStarted },
          {
            kind: TurnEventKind.TurnFailed,
            code: "AOS_PROVIDER_RUN_FAILED",
            message: `Hermes could not complete this turn.\n${OPERATOR_PATH} is locked`,
          },
        ]),
    })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)

    await test.prompt("Start the interview").catch(() => undefined)

    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("request_failed")
    )
    expect(JSON.stringify(test.recorder.entries)).not.toContain(OPERATOR_PATH)
    test.close()
  })

  it("offers an approval without its Agent-wide or Session-wide scopes", async () => {
    const test = harness({
      existing: true,
      handle: () => terminalHandle(REQUEST_EVENTS),
    })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)

    await test.prompt("Delete the notes")

    const asked = await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission
    )
    expect(asked.params).toMatchObject({
      sessionId: REF,
      options: [{ optionId: "once", kind: "allow_once" }],
    })
    expect(JSON.stringify(asked.params)).not.toContain("allow_always")
    expect(JSON.stringify(asked.params)).not.toContain("allow_session")
    test.close()
  })

  it("refuses an approval answer that widens the grant", async () => {
    const test = harness({
      existing: true,
      handle: () => terminalHandle(REQUEST_EVENTS),
      permission: async () => ({
        outcome: { outcome: "selected", optionId: "always" },
      }),
    })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)

    await test.prompt("Delete the notes")

    const reported = await test.recorder.wait(
      (entry) => entry.method === AOS_METHODS.notify.error
    )
    expect(reported.params).toMatchObject({
      sessionId: REF,
      code: "invalid_request",
    })
    // The refused answer starts no reply segment.
    expect(test.start).toHaveBeenCalledTimes(1)
    test.close()
  })

  it("withdraws its request once an operator answers it", async () => {
    const withdrawal = Promise.withResolvers<AbortSignal>()
    const test = harness({
      existing: true,
      handle: () =>
        terminalHandle(
          test.start.mock.calls.length > 1 ? RUN_EVENTS : REQUEST_EVENTS
        ),
      permission: (_params, signal) => {
        withdrawal.resolve(signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason))
        })
      },
    })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)
    await test.prompt("Delete the notes")
    const signal = await withdrawal.promise

    // The operator addresses the Session by its own public id.
    const reply = await test.coordinator.start(
      { agentId: AGENT, sessionId: STORED, threadId: "operator-view" },
      {
        turnId: "operator-reply",
        replies: [{ requestId: APPROVAL.requestId, status: "resolved" }],
      },
      {
        subscriberId: "operator",
        controllerId: "operator",
        lane: "operator",
        canControl: true,
      }
    )

    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    reply.close()
    // The guest follows the operator's reply to its end, past the withdrawal.
    await test.recorder.wait(
      (entry) =>
        entry.method === methods.client.session.update &&
        (entry.params as { update?: { state?: unknown } }).update?.state ===
          "idle"
    )
    expect(test.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    expect(test.start).toHaveBeenCalledTimes(2)
    test.close()
  })

  it("stops its own run through the controller the projection grants", async () => {
    const test = harness({
      existing: true,
      handle: () =>
        openHandle(
          RUN_EVENTS.filter((event) => event.kind !== TurnEventKind.TurnEnded)
        ),
    })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)
    await test.prompt("Start the interview")
    await test.recorder.wait((entry) =>
      JSON.stringify(entry.params).includes("Guest-visible answer")
    )

    await test.agent.notify(methods.agent.session.cancel, { sessionId: REF })

    await vi.waitFor(() =>
      expect(test.handles.at(0)?.stop).toHaveBeenCalledOnce()
    )
    expect(test.recorder.of(AOS_METHODS.notify.error)).toEqual([])
    test.close()
  })

  it("ignores focus, which belongs to the operator's read state", async () => {
    const test = harness({ existing: true })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)

    await test.agent.notify(AOS_METHODS.session.focus, { sessionId: REF })
    await test.resume(REF)

    expect(test.updateSession).not.toHaveBeenCalled()
    expect(test.runtimeInfo).not.toHaveBeenCalled()
    test.close()
  })

  it("carries no activity from any Session of the invited Agent", async () => {
    const test = harness({ existing: true })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)

    const other = await test.coordinator.start(
      { agentId: AGENT, sessionId: "operator-session", threadId: "operator" },
      { turnId: "operator-turn", messageId: "operator-message", prompt: "Hi" },
      {
        subscriberId: "operator",
        controllerId: "operator",
        lane: "operator",
        canControl: true,
      }
    )
    for await (const _ of other.events) void _
    await test.prompt("Hello")
    await test.recorder.wait(
      (entry) =>
        entry.method === methods.client.session.update &&
        JSON.stringify(entry.params).includes('"idle"')
    )

    expect(test.recorder.of(AOS_METHODS.notify.activity)).toEqual([])
    // Nor does it list the deployment's Sessions to seed one.
    expect(test.listAllSessions).not.toHaveBeenCalled()
    test.close()
  })

  it("closes the connection when the invitation expires", async () => {
    const test = harness({ existing: true })
    await test.initialize()
    await test.login(await invite(test.invitations))
    await test.resume(REF)

    const expiry = await vi.waitFor(() => {
      const scheduled = test.scheduled.at(0)
      if (!scheduled) throw new Error("No expiry was scheduled")
      return scheduled
    })
    expect(expiry.delayMs).toBe(259_200_000)
    expiry.task()

    await expect(test.closed).resolves.toBeUndefined()
  })
})
