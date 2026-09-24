import { expandByKeyboard } from "./disclosure"
import { expect, test, type Page } from "./test"

/**
 * The operator surface over one scripted ACP v2 connection. A fake
 * `window.WebSocket` answers the proxy's operator lane with JSON-RPC and pushes
 * the `session/update` notifications a real proxy emits; REST carries only the
 * runtime read.
 */

const AGENT_ID = "research"
const SESSION_ID = "session-1"
const TURN_ID = "run-1"
const ACP_PATH = "/api/aos/v1/acp"
/** A prompt the scripted provider leaves running until it is cancelled. */
const PENDING_PROMPT = "Keep running until I stop it"
/** A prompt the scripted provider answers with `vocabularyTurn`. */
const VOCABULARY_PROMPT = "Lengthen the trial and run the tests"
/** The Session the scripted turn's subagent runs in. */
const CHILD_SESSION_ID = "session-2"
/** A prompt whose turn asks permission to run the tool call it guards. */
const GUARDED_PERMISSION_PROMPT = "Clean the build directory"
/** A prompt whose turn asks a permission no tool call carries. */
const STANDALONE_PERMISSION_PROMPT = "Ask before touching the network"
/** The tool call the guarded permission request is about. */
const GUARDED_TOOL_CALL_ID = "clean-build"

const runtime = {
  runtime: { id: "hermes", name: "Hermes" },
  status: "ready",
  capabilities: {
    agentCatalog: { status: "available" },
    agentVisibility: { status: "available" },
    sessionCatalog: {
      status: "available",
      scope: "workspace",
      order: "recent",
      defaultPageSize: 50,
      maxPageSize: 100,
      maxWindow: 1000,
    },
    sessionHistory: {
      status: "available",
      order: "chronological",
      compacted: true,
      loading: "on-open",
      defaultPageSize: 200,
      maxPageSize: 500,
    },
    sessionDetail: { status: "available" },
    sessionCreation: { status: "available" },
    sessionTitle: { status: "available" },
    sessionArchival: { status: "available" },
    sessionPin: { status: "available" },
    sessionDeletion: { status: "available" },
    sessionTurn: { status: "available" },
    sessionStop: { status: "available" },
    sessionSteer: { status: "available" },
    sessionReadState: { status: "available" },
  },
}

/** Enough commands that the menu has to scroll to reach the later ones. */
const slashCommands = Array.from({ length: 30 }, (_, index) => ({
  name: `command-${index}`,
  description: `Command ${index}`,
}))

/** `ResumeSessionResponse._meta.aos.capabilities`. */
const sessionCapabilities = {
  workspace: {
    slashCommands: {
      status: "available",
      scope: "attached-session",
      commands: slashCommands,
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
    todos: {
      status: "available",
      scope: "session",
      mode: "read-only-projection",
      source: "latest-completed-todo-tool-result",
    },
    activity: {
      status: "available",
      scope: "attached-active-session",
      coverage: "active-session-only",
      source: "provider-session-state",
    },
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
      protocol: "acp-request",
      scope: "turn",
      choices: [
        { value: "once", scope: "request" },
        { value: "session", scope: "session" },
        { value: "always", scope: "agent" },
        { value: "deny", scope: "request" },
      ],
      maxPending: 64,
    },
    questions: {
      status: "available",
      protocol: "acp-request",
      scope: "turn",
      answerModes: ["single", "multiple", "free-text"],
      cancellation: "native-empty-answer",
      maxQuestions: 32,
      maxChoicesPerQuestion: 64,
      maxAnswerValuesPerQuestion: 64,
      maxStringBytes: 4096,
    },
    reactions: { status: "unavailable", reason: "not-supported" },
  },
  content: {
    attachments: {
      status: "available",
      scope: "attached-session",
      inputs: ["image", "file"],
      imageMimeTypes: ["image/png"],
      fileMimeTypes: "valid-type/subtype",
      maxMimeTypeBytes: 256,
      maxFilenameBytes: 255,
      maxCount: 16,
      maxImageBytes: 26_214_400,
      maxFileBytes: 26_214_400,
      maxTotalBytes: 26_214_400,
    },
    artifacts: { status: "unavailable", reason: "not-supported" },
    mcpApps: { status: "unavailable", reason: "not-supported" },
    transcription: { status: "unavailable", reason: "not-configured" },
    speech: { status: "unavailable", reason: "not-configured" },
  },
}

const VOCABULARY_ANSWER_ID = "vocabulary-answer"
const TOOL_CLOCK = Date.parse("2026-09-12T00:00:00.000Z")
/** An instant `ms` after the scripted tools started. */
const toolTime = (ms: number) => new Date(TOOL_CLOCK + ms).toISOString()
/** Tool updates hang off the answer the turn is writing. */
const onAnswer = (aos: Record<string, unknown> = {}) => ({
  aos: { messageId: VOCABULARY_ANSWER_ID, ...aos },
})

/**
 * One turn in the wire shapes `packages/proxy/acp/translate/turn-events.ts`
 * emits: an edit with its location and diff, a command with a live terminal, a
 * compaction, a subagent with its own Session, a provider model switch, and a
 * length stop that reports its usage and cost.
 */
const vocabularyTurn = [
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "edit-1",
    title: "Edit tiers.ts",
    name: "edit_file",
    kind: "edit",
    status: "in_progress",
    locations: [{ path: "/w/src/pricing/tiers.ts", line: 2 }],
    _meta: onAnswer({ startedAt: toolTime(0) }),
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "edit-1",
    status: "completed",
    rawOutput: "updated",
    content: [
      { type: "content", content: { type: "text", text: "updated" } },
      {
        type: "diff",
        changes: [{ operation: "modify", path: "/w/src/pricing/tiers.ts" }],
        patch: {
          format: "git_patch",
          text: [
            "--- a/src/pricing/tiers.ts",
            "+++ b/src/pricing/tiers.ts",
            "@@ -1,2 +1,3 @@",
            ' export const tiers = ["starter", "team"]',
            "-export const trialDays = 14",
            "+export const trialDays = 30",
            '+export const enterprise = "contact sales"',
          ].join("\n"),
        },
      },
    ],
    _meta: onAnswer({ completedAt: toolTime(1_200) }),
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "run-tests",
    title: "bun run test",
    name: "run_command",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "bun run test" },
    _meta: onAnswer({ startedAt: toolTime(2_000) }),
  },
  {
    sessionUpdate: "terminal_update",
    terminalId: "term-1",
    command: "bun run test",
    cwd: "/w",
  },
  {
    sessionUpdate: "tool_call_content_chunk",
    toolCallId: "run-tests",
    content: { type: "terminal", terminalId: "term-1" },
    _meta: onAnswer(),
  },
  {
    sessionUpdate: "terminal_output_chunk",
    terminalId: "term-1",
    data: Buffer.from(" ✓ tiers.test.ts (3)\n", "utf8").toString("base64"),
  },
  {
    sessionUpdate: "terminal_update",
    terminalId: "term-1",
    exitStatus: { exitCode: 0 },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "run-tests",
    status: "completed",
    rawOutput: "3 passed",
    content: [
      { type: "content", content: { type: "text", text: "3 passed" } },
      { type: "terminal", terminalId: "term-1" },
    ],
    _meta: onAnswer({ completedAt: toolTime(5_000) }),
  },
  {
    sessionUpdate: "compaction_update",
    compactionId: "compaction-1",
    status: "completed",
    summary: [{ type: "text", text: "The trial change is made and tested." }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "delegate-1",
    title: "Check the pricing page",
    name: "delegate_task",
    kind: "other",
    status: "completed",
    rawOutput: "The page matches.",
    content: [
      { type: "content", content: { type: "text", text: "The page matches." } },
    ],
    _meta: onAnswer({
      subagent: {
        id: "subagent-1",
        goal: "Check the pricing page",
        status: "completed",
        childSessionId: CHILD_SESSION_ID,
      },
    }),
  },
  // The proxy restates the model options when the provider switches models.
  {
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        type: "select",
        configId: "model",
        name: "Model",
        category: "model",
        currentValue: "deep",
        options: [
          { value: "default", name: "Default" },
          { value: "deep", name: "Deep" },
        ],
      },
    ],
  },
  {
    sessionUpdate: "agent_message_chunk",
    messageId: VOCABULARY_ANSWER_ID,
    content: { type: "text", text: "The trial is now 30 days, and then" },
  },
  {
    sessionUpdate: "state_update",
    state: "idle",
    stopReason: "max_tokens",
    usage: {
      inputTokens: 12_000,
      outputTokens: 3_400,
      totalTokens: 15_400,
      cachedReadTokens: 6_000,
    },
    _meta: { aos: { cost: { amount: 0.25, currency: "USD" } } },
  },
]

/**
 * `session/request_permission` params in the shape `permissionOutbound` in
 * `packages/proxy/acp/translate/requests.ts` builds: the schema title names the
 * operation, the message explains it, and a request that knows its tool call
 * names it as the subject.
 */
function permissionRequest(requestId: string, toolCallId?: string) {
  const title = "Run command"
  const message = "Delete the build directory?"
  return {
    sessionId: SESSION_ID,
    title,
    description: message,
    ...(toolCallId === undefined
      ? {}
      : {
          subject: {
            type: "tool_call",
            toolCall: { toolCallId, title, status: "pending" },
          },
        }),
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    _meta: { aos: { requestId, message } },
  }
}

/** Every payload the scripted responder answers with, in one serializable object. */
const script = {
  acpPath: ACP_PATH,
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  pendingPrompt: PENDING_PROMPT,
  vocabularyPrompt: VOCABULARY_PROMPT,
  vocabularyTurn,
  guardedPermissionPrompt: GUARDED_PERMISSION_PROMPT,
  standalonePermissionPrompt: STANDALONE_PERMISSION_PROMPT,
  /** The guarded command the permission turn streams before it waits. */
  guardedToolCall: {
    sessionUpdate: "tool_call_update",
    toolCallId: GUARDED_TOOL_CALL_ID,
    title: "rm -rf build",
    name: "run_command",
    kind: "execute",
    status: "pending",
    rawInput: { command: "rm -rf build" },
  },
  guardedPermission: permissionRequest("permission-1", GUARDED_TOOL_CALL_ID),
  standalonePermission: permissionRequest("permission-2"),
  /** `InitializeResponse._meta.aos` for the operator lane. */
  initializeMeta: {
    version: 1,
    lane: "operator",
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
      historyPages: false,
    },
  },
  agentCatalog: {
    revision: "catalog-1",
    agents: [
      {
        summary: {
          kind: "ready",
          id: AGENT_ID,
          name: "Research",
          status: "idle",
        },
        visibility: "visible",
        selectable: true,
        editable: false,
        revision: "research-1",
      },
    ],
  },
  sessions: [
    {
      sessionId: SESSION_ID,
      cwd: "/",
      title: "Research",
      updatedAt: "2026-09-12T00:00:00.000Z",
      _meta: {
        aos: {
          agentId: AGENT_ID,
          status: "idle",
          archived: false,
          unread: false,
        },
      },
    },
  ],
  configOptions: [
    {
      type: "select",
      configId: "model",
      name: "Model",
      category: "model",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "deep", name: "Deep" },
      ],
    },
  ],
  resumeMeta: {
    session: {
      agentId: AGENT_ID,
      status: "idle",
      archived: false,
      unread: false,
    },
    execution: { status: "idle" },
    capabilities: sessionCapabilities,
  },
  history: [
    { role: "user", messageId: "history-user", text: "Restore my research." },
    {
      role: "assistant",
      messageId: "history-answer",
      text: "Restored from AOS.",
    },
  ],
  /**
   * A history too long for one replay: a from-start resume sends only its
   * newest page, and each `_aos/before` read sends the page before its cursor,
   * held until the test calls `__acpStub.releasePage()`.
   */
  pagedHistory: null as PagedHistory | null,
  recovered: {
    messageId: "reconnect-answer",
    text: "Recovered after reconnect.",
  },
  reply: ["Streamed by AOS.", "Both chunks arrived."],
  // 42k of a 200k window, attributed the way a provider reports it: the counts
  // are ACP's own fields, the attribution is the AOS extension's meta.
  usage: {
    used: 42_000,
    size: 200_000,
    _meta: {
      aos: {
        source: "provider-usage",
        breakdown: {
          systemTokens: 8_000,
          toolTokens: 12_000,
          messageTokens: 22_000,
        },
      },
    },
  },
}

type PagedHistory = {
  pageSize: number
  messages: { role: string; messageId: string; text: string }[]
}
type AcpScript = typeof script
type AcpCall = { method: string; params: unknown }
type AcpReply = { method: string; result?: unknown; error?: unknown }
type ResumeParams = {
  sessionId: string
  replayFrom?: { type: string }
  _meta?: { aos?: { agentId?: string; after?: number; turnId?: string } }
}

declare global {
  interface Window {
    __acpStub: {
      /** Every JSON-RPC call the browser sent, in order. */
      calls: AcpCall[]
      /** Every reply the browser sent to a request the stub made, in order. */
      replies: AcpReply[]
      /** How many transports the browser has opened. */
      connections: number
      /** The newest `_meta.aos.sequence` the stub has emitted. */
      sequence: number
      /** Drops the live transport, as a proxy restart would. */
      dropSocket: () => void
      /** Sends the held `_aos/before` page, if one is waiting. */
      releasePage: () => void
    }
  }
}

/**
 * Replaces `window.WebSocket` for the operator lane with a scripted JSON-RPC
 * responder: a method table, sequenced run updates, and a droppable transport.
 */
function installAcpStub(script: AcpScript) {
  const RealWebSocket = window.WebSocket
  const stub: Window["__acpStub"] = {
    calls: [],
    replies: [],
    connections: 0,
    sequence: 0,
    dropSocket: () => {},
    releasePage: () => {},
  }
  window.__acpStub = stub
  let turn = 0
  let requests = 0

  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}

  const promptText = (params: Record<string, unknown>) =>
    (Array.isArray(params.prompt) ? params.prompt : [])
      .map((block) => asRecord(block).text)
      .filter((text): text is string => typeof text === "string")
      .join(" ")

  class AcpStubSocket extends EventTarget {
    readyState = 0
    handlers = new Map<
      string,
      (params: Record<string, unknown>, id: unknown) => void
    >()
    /** Requests this stub made that the browser has not answered yet. */
    outstanding = new Map<
      unknown,
      { method: string; onReply: (reply: AcpReply) => void }
    >()

    constructor() {
      super()
      stub.connections += 1
      stub.dropSocket = () => this.closeTransport()
      this.registerHandlers()
      queueMicrotask(() => {
        this.readyState = 1
        this.dispatchEvent(new Event("open"))
      })
    }

    send(raw: string) {
      const payload: unknown = JSON.parse(raw)
      for (const message of Array.isArray(payload) ? payload : [payload])
        this.accept(asRecord(message))
    }

    close() {
      this.closeTransport()
    }

    closeTransport() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.dispatchEvent(new Event("close"))
    }

    accept(message: Record<string, unknown>) {
      const method = message.method
      if (typeof method !== "string") return this.acceptReply(message)
      const params = asRecord(message.params)
      stub.calls.push({ method, params })
      const handler = this.handlers.get(method)
      if (handler) return handler(params, message.id)
      if (message.id !== undefined)
        this.deliver({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unscripted ACP method: ${method}` },
        })
    }

    /** A reply to one of this stub's own requests, recorded in order. */
    acceptReply(message: Record<string, unknown>) {
      const request = this.outstanding.get(message.id)
      if (!request) return
      this.outstanding.delete(message.id)
      const reply: AcpReply = { method: request.method }
      if ("result" in message) reply.result = message.result
      if ("error" in message) reply.error = message.error
      stub.replies.push(reply)
      request.onReply(reply)
    }

    /**
     * A real socket dispatches every frame as its own task, so the browser has
     * finished reacting to one frame, a resume's answer included, before the
     * next arrives. Microtasks would hand a frame over mid-reaction instead.
     */
    deliver(frame: Record<string, unknown>) {
      setTimeout(() => {
        if (this.readyState !== 1) return
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(frame) })
        )
      })
    }

    respond(id: unknown, result: unknown) {
      this.deliver({ jsonrpc: "2.0", id, result })
    }

    notify(method: string, params: unknown) {
      this.deliver({ jsonrpc: "2.0", method, params })
    }

    /** A server-to-client request; `onReply` runs once the browser answers. */
    request(
      method: string,
      params: unknown,
      onReply: (reply: AcpReply) => void = () => {}
    ) {
      requests += 1
      const id = `stub-request-${requests}`
      this.outstanding.set(id, { method, onReply })
      this.deliver({ jsonrpc: "2.0", id, method, params })
    }

    /** One unsequenced `session/update`, as a replay or an out-of-band read. */
    update(update: Record<string, unknown>) {
      this.notify("session/update", { sessionId: script.sessionId, update })
    }

    /** One run-stream `session/update`, carrying its position in the run. */
    run(update: Record<string, unknown>) {
      stub.sequence += 1
      const aos = asRecord(asRecord(update._meta).aos)
      this.update({
        ...update,
        _meta: {
          aos: { ...aos, sequence: stub.sequence, turnId: script.turnId },
        },
      })
    }

    message(
      role: string,
      messageId: string,
      text: string,
      meta?: Record<string, unknown>
    ) {
      this.update({
        sessionUpdate: role === "user" ? "user_message" : "agent_message",
        messageId,
        content: [{ type: "text", text }],
        ...(meta ? { _meta: { aos: meta } } : {}),
      })
    }

    /**
     * The page ending `offset` messages before the newest, as the proxy reads
     * it: its messages, then the cursor of the page before it, if any.
     */
    historyPage(
      paged: PagedHistory,
      offset: number,
      meta?: Record<string, unknown>
    ) {
      const end = paged.messages.length - offset
      const start = Math.max(0, end - paged.pageSize)
      for (const entry of paged.messages.slice(start, end))
        this.message(entry.role, entry.messageId, entry.text, meta)
      return start > 0 ? { nextCursor: `offset-${offset + end - start}` } : {}
    }

    registerHandlers() {
      this.handlers.set("initialize", (_params, id) =>
        this.respond(id, {
          protocolVersion: 2,
          info: { name: "aos-proxy-stub", version: "1" },
          capabilities: {},
          authMethods: [],
          _meta: { aos: script.initializeMeta },
        })
      )
      this.handlers.set("_aos/agents/list", (_params, id) =>
        this.respond(id, script.agentCatalog)
      )
      this.handlers.set("session/list", (_params, id) =>
        this.respond(id, { sessions: script.sessions })
      )
      // A resume from the start replays the stored turns; a resume positioned
      // by `_meta.aos.after` reports only what the dropped transport missed.
      this.handlers.set("session/resume", (params, id) => {
        // A subagent's own Session opens with nothing stored.
        if (params.sessionId !== script.sessionId)
          return this.respond(id, {
            configOptions: script.configOptions,
            _meta: { aos: script.resumeMeta },
          })
        const replayFrom = asRecord(params.replayFrom)
        const paged = script.pagedHistory
        // An older page is its own read: tagged updates and a cursor, with no
        // reattach, so neither the configuration nor the window is restated.
        if (paged && replayFrom.type === "_aos/before") {
          const cursor = String(replayFrom.cursor)
          const offset = Number(cursor.replace("offset-", ""))
          stub.releasePage = () => {
            stub.releasePage = () => {}
            const history = this.historyPage(paged, offset, {
              historyPage: { cursor },
            })
            this.respond(id, { _meta: { aos: { history } } })
          }
          return
        }
        if (paged && replayFrom.type === "start") {
          const history = this.historyPage(paged, 0)
          this.respond(id, {
            configOptions: script.configOptions,
            _meta: { aos: { ...script.resumeMeta, history } },
          })
          return
        }
        if (replayFrom.type === "start")
          for (const entry of script.history)
            this.message(entry.role, entry.messageId, entry.text)
        else
          this.message(
            "assistant",
            script.recovered.messageId,
            script.recovered.text
          )
        this.respond(id, {
          configOptions: script.configOptions,
          _meta: { aos: script.resumeMeta },
        })
        this.update({ sessionUpdate: "usage_update", ...script.usage })
      })
      // The prompt is acknowledged with the minted user message id, then the
      // turn streams. The pending prompt stays running until it is cancelled.
      this.handlers.set("session/prompt", (params, id) => {
        turn += 1
        const messageId = `user-${turn}`
        const answerId = `answer-${turn}`
        this.respond(id, { _meta: { aos: { messageId } } })
        this.update({
          sessionUpdate: "user_message",
          messageId,
          content: params.prompt,
        })
        this.run({ sessionUpdate: "state_update", state: "running" })
        if (promptText(params).includes(script.pendingPrompt)) return
        const settle = () =>
          this.run({
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          })
        // A permission turn waits on the operator, as the proxy's
        // `requiresActionOutbound` does: the wait, then the request.
        if (promptText(params).includes(script.guardedPermissionPrompt)) {
          const call = script.guardedToolCall
          this.run({ ...call, _meta: { aos: { messageId: answerId } } })
          this.run({ sessionUpdate: "state_update", state: "requires_action" })
          this.request(
            "session/request_permission",
            script.guardedPermission,
            () => {
              this.run({
                sessionUpdate: "tool_call_update",
                toolCallId: call.toolCallId,
                status: "completed",
                rawOutput: "removed",
                _meta: { aos: { messageId: answerId } },
              })
              settle()
            }
          )
          return
        }
        if (promptText(params).includes(script.standalonePermissionPrompt)) {
          this.run({ sessionUpdate: "state_update", state: "requires_action" })
          this.request(
            "session/request_permission",
            script.standalonePermission,
            settle
          )
          return
        }
        if (promptText(params).includes(script.vocabularyPrompt)) {
          // A model switch is Session state, not a position in the run.
          for (const update of script.vocabularyTurn)
            if (update.sessionUpdate === "config_option_update")
              this.update(update)
            else this.run(update)
          // A settled turn restates the context window.
          this.update({ sessionUpdate: "usage_update", ...script.usage })
          return
        }
        for (const text of script.reply)
          this.run({
            sessionUpdate: "agent_message_chunk",
            messageId: answerId,
            content: { type: "text", text },
          })
        this.run({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        })
      })
      this.handlers.set("session/cancel", () =>
        this.run({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "cancelled",
        })
      )
      this.handlers.set("session/set_config_option", (params, id) => {
        const configOptions = script.configOptions.map((option) =>
          option.configId === params.configId &&
          typeof params.value === "string"
            ? { ...option, currentValue: params.value }
            : option
        )
        this.respond(id, { configOptions })
        this.update({ sessionUpdate: "config_option_update", configOptions })
      })
      this.handlers.set("_aos/session/update", (_params, id) =>
        this.respond(id, {})
      )
      // Focus is a notification; recording it is all the proxy owes the browser.
      this.handlers.set("_aos/session/focus", () => {})
    }
  }

  function WebSocketProxy(url: string | URL, protocols?: string | string[]) {
    return String(url).includes(script.acpPath)
      ? new AcpStubSocket()
      : new RealWebSocket(url, protocols)
  }
  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    value: WebSocketProxy,
  })
}

async function serveAcp(page: Page, overrides: Partial<AcpScript> = {}) {
  await page.addInitScript(installAcpStub, { ...script, ...overrides })
  await page.route("**/runtime-config.json", (route) =>
    route.fulfill({ json: { mode: "aos" } })
  )
  // The runtime read and the push status probe are the only REST routes this
  // journey needs; the real proxy answers the probe even without push set up.
  await page.route("**/api/aos/v1/**", (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname.endsWith("/runtime")) return route.fulfill({ json: runtime })
    if (pathname.endsWith("/push"))
      return route.fulfill({ json: { status: "not-configured" } })
    return route.fulfill({
      status: 404,
      json: { error: { code: "not_found" } },
    })
  })
}

function recorded(page: Page, method: string) {
  return page.evaluate(
    (method) => window.__acpStub.calls.filter((call) => call.method === method),
    method
  )
}

async function resumes(page: Page) {
  return (await recorded(page, "session/resume")).map(
    (call) => call.params as ResumeParams
  )
}

test("AOS proxy restores history, offers commands, streams one turn, stops, and reconnects", async ({
  page,
}) => {
  await serveAcp(page)
  await page.goto("/")

  // The replay arrives before the resume answers, so both stored turns render.
  await expect(page.getByText("Restore my research.")).toBeVisible()
  await expect(page.getByText("Restored from AOS.")).toBeVisible()
  expect((await resumes(page))[0]?.replayFrom).toEqual({ type: "start" })

  const input = page.getByRole("textbox", { name: "Message input" })
  await input.fill("/")
  const commandMenu = page.getByRole("listbox")
  // Every provider command, after the workspace's own local `/new`.
  await expect(commandMenu.getByRole("option")).toHaveCount(
    slashCommands.length + 1
  )
  await expect(commandMenu.getByRole("option").first()).toHaveAccessibleName(
    /^\/new\b/
  )
  for (let index = 0; index < 15; index += 1) await input.press("ArrowDown")
  await expect
    .poll(() => commandMenu.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  await input.press("Escape")
  await input.fill("/command-2")
  await page.getByRole("option", { name: /^\/command-2\b/ }).click()
  await expect(input).toHaveValue("/command-2 ")

  await input.fill("Send once")
  await page.getByRole("button", { name: "Send message" }).click()
  // The chunks extend one content part, so the turn reads as one paragraph.
  await expect(
    page.getByText("Streamed by AOS.Both chunks arrived.")
  ).toBeVisible()
  await expect(
    page.getByText("Both chunks arrived.", { exact: true })
  ).toHaveCount(0)
  expect(await recorded(page, "session/prompt")).toHaveLength(1)

  // The window the resume reported reaches the composer, attributed: a Session
  // the operator returns to opens on the context it actually carries.
  await page.getByRole("button", { name: "Context usage" }).focus()
  await expect(page.getByText("42k / 200k")).toBeVisible()
  for (const shown of ["System", "8k", "Tools", "12k", "Messages", "22k"])
    await expect(page.getByText(shown, { exact: true })).toBeVisible()

  // Stop: the scripted turn stays running until the cancel notification.
  await input.fill(PENDING_PROMPT)
  await page.getByRole("button", { name: "Send message" }).click()
  const stop = page.getByRole("button", { name: "Stop generating" })
  await expect(stop).toBeVisible()
  await stop.click()
  await expect(stop).toHaveCount(0)
  await expect
    .poll(() => recorded(page, "session/cancel"))
    .toEqual([{ method: "session/cancel", params: { sessionId: SESSION_ID } }])
  await expect(input).toBeVisible()
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible()

  // The exposed Session is reported to the proxy, which owns read state, along
  // with this connection's presence for push delivery.
  await expect
    .poll(() => recorded(page, "_aos/session/focus"))
    .toContainEqual({
      method: "_aos/session/focus",
      params: { sessionId: SESSION_ID, foreground: true, idle: false },
    })

  // A dropped transport re-initializes and resumes from the last sequence seen.
  const sequence = await page.evaluate(() => window.__acpStub.sequence)
  await page.evaluate(() => window.__acpStub.dropSocket())
  await expect
    .poll(() => page.evaluate(() => window.__acpStub.connections))
    .toBe(2)
  await expect
    .poll(async () => (await recorded(page, "initialize")).length)
    .toBe(2)
  await expect
    .poll(async () => (await resumes(page)).at(-1)?._meta?.aos)
    .toEqual({ agentId: AGENT_ID, after: sequence, turnId: TURN_ID })
  await expect(page.getByText("Recovered after reconnect.")).toBeVisible()
})

test("AOS proxy loads a long Session's earlier messages as the reader scrolls up, keeping their place", async ({
  page,
}) => {
  // Five pages of scrolling through 1,200 messages outlast the default budget
  // on a loaded machine.
  test.slow()
  const length = 1_200
  const text = (index: number) => `Long history message ${index}`
  await serveAcp(page, {
    initializeMeta: {
      ...script.initializeMeta,
      extensions: { ...script.initializeMeta.extensions, historyPages: true },
    },
    pagedHistory: {
      // Even pages start at a user message, as the proxy's turn-aligned pages do.
      pageSize: 200,
      messages: Array.from({ length }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        messageId: `older-${index}`,
        text: text(index),
      })),
    },
  })
  await page.goto("/")

  // The Session opens at its latest message, not at its first.
  const newest = page.getByText(text(length - 1), { exact: true })
  await expect(newest).toBeInViewport()
  const box = await newest.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)

  const pageReads = async () =>
    (await resumes(page)).filter(
      (call) => call.replayFrom?.type === "_aos/before"
    ).length
  // The message nearest the top of the thread that the reader can see whole.
  const firstInView = () =>
    page.evaluate(() => {
      const shown = [...document.querySelectorAll("[data-message-id]")].find(
        (row) => {
          const { top, bottom } = row.getBoundingClientRect()
          return top >= 0 && bottom <= window.innerHeight
        }
      )
      return /Long history message \d+/.exec(shown?.textContent ?? "")?.[0]
    })

  const beginning = page.getByText("Beginning of conversation")
  for (let loaded = 0; loaded < length / 200 - 1; loaded += 1) {
    // The reader scrolls up until the read-ahead margin asks for the page
    // before; the stub holds it, so the reader's place is fixed when it lands.
    await expect(async () => {
      if ((await pageReads()) === loaded) await page.mouse.wheel(0, -6_000)
      expect(await pageReads()).toBe(loaded + 1)
    }).toPass({ intervals: [50] })
    const anchor = await firstInView()
    expect(anchor).toBeDefined()
    await page.evaluate(() => window.__acpStub.releasePage())
    await expect(
      page.getByRole("button", { name: "Loading earlier messages" })
    ).toHaveCount(0)
    // Prepending a page moves nothing the reader is looking at.
    await expect(page.getByText(anchor!, { exact: true })).toBeInViewport()
  }

  // The last page carries no cursor: the thread says so, reads no further,
  // and the reader can scroll to the very first message.
  await expect(beginning).toBeAttached()
  const first = page.getByText(text(0), { exact: true })
  await expect(async () => {
    await page.mouse.wheel(0, -6_000)
    await expect(first).toBeInViewport({ timeout: 500 })
  }).toPass({ intervals: [50] })
  await expect(beginning).toBeInViewport()
  expect(await pageReads()).toBe(length / 200 - 1)
})

test("AOS proxy renders a turn's tools, diff, terminal, compaction, subagent, stop and usage from the wire", async ({
  page,
}) => {
  await serveAcp(page, {
    sessions: [
      ...script.sessions,
      {
        sessionId: CHILD_SESSION_ID,
        cwd: "/",
        title: "Pricing page check",
        updatedAt: "2026-09-11T00:00:00.000Z",
        _meta: {
          aos: {
            agentId: AGENT_ID,
            status: "idle",
            archived: false,
            unread: false,
          },
        },
      },
    ],
  })
  await page.goto("/")
  await expect(page.getByText("Restored from AOS.")).toBeVisible()
  const model = page.getByRole("combobox", { name: "Choose model" })
  await expect(model).toContainText("Default")

  await page
    .getByRole("textbox", { name: "Message input" })
    .fill(VOCABULARY_PROMPT)
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByText("The trial is now 30 days, and then", { exact: true })
  ).toBeVisible()

  // A max_tokens stop is a length stop, named on the fold and beneath the answer.
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The answer stopped at the length limit." })
  ).toBeVisible()
  await expandByKeyboard(
    page.getByRole("button", { name: /^Stopped at the length limit/ })
  )

  // The edit row names its kind, location, line totals and duration; its diff
  // stays folded until the row opens.
  const edit = page.getByRole("button", {
    name: "Edited /w/src/pricing/tiers.ts:2 2 lines added, 1 removed 1s",
    exact: true,
  })
  await expect(page.getByRole("list", { name: "Changed files" })).toHaveCount(0)
  await expandByKeyboard(edit)
  await expect(page.getByRole("list", { name: "Changed files" }))
    .toMatchAriaSnapshot(`
    - listitem: Modified /w/src/pricing/tiers.ts
  `)
  await expect(
    page.getByText("export const trialDays = 30", { exact: true })
  ).toBeVisible()

  // The command's terminal decodes the base64 output ACP carried.
  await expandByKeyboard(
    page.getByRole("button", { name: "Ran bun run test 3s", exact: true })
  )
  await expect(
    page.getByRole("region", { name: "Terminal output" })
  ).toContainText("✓ tiers.test.ts (3)")
  await expect(
    page.getByRole("status").filter({ hasText: "Command ended. Exit code 0" })
  ).toBeVisible()

  await expandByKeyboard(
    page.getByRole("button", { name: "Context compacted", exact: true })
  )
  await expect(
    page.getByText("The trial change is made and tested.", { exact: true })
  ).toBeVisible()

  // The provider's model switch reaches the composer's selector.
  await expect(model).toContainText("Deep")

  // The idle update's usage and cost reach the context popover.
  await page.getByRole("button", { name: "Context usage" }).focus()
  for (const shown of [
    "Last turn",
    "12K in · 3.4K out · 6K cached",
    "Session cost",
    "$0.25",
  ])
    await expect(page.getByText(shown, { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")

  // The subagent's own Session opens in place from its activity.
  await page.getByRole("link", { name: "Open session" }).click()
  await expect(
    page.getByRole("tab", { name: "Pricing page check" })
  ).toHaveAttribute("aria-selected", "true")
  await expect
    .poll(async () => (await resumes(page)).map((call) => call.sessionId))
    .toContain(CHILD_SESSION_ID)
})

test("AOS proxy answers a permission request on the tool call it guards, and one that stands alone", async ({
  page,
}) => {
  await serveAcp(page)
  await page.goto("/")
  await expect(page.getByText("Restored from AOS.")).toBeVisible()
  const input = page.getByRole("textbox", { name: "Message input" })
  const card = page.getByRole("heading", { name: "Permission request" })
  const choices = page.getByRole("group", {
    name: "Delete the build directory?",
  })
  const replies = () => page.evaluate(() => window.__acpStub.replies)
  const allowed = {
    method: "session/request_permission",
    result: { outcome: { outcome: "selected", optionId: "once" } },
  }

  // The request that names its tool call is answered on that call, and the
  // composer stays the composer rather than turning into a Questions form.
  await input.fill(GUARDED_PERMISSION_PROMPT)
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(choices).toBeVisible()
  await expect(card).toHaveCount(1)
  await expect(input).toBeVisible()
  await expect(page.getByRole("button", { name: "Send answer" })).toHaveCount(0)

  await choices.getByRole("button", { name: "Allow once" }).click()
  await expect.poll(replies).toEqual([allowed])
  // The card was the call's own: once the call settles, its outcome replaces
  // the card, where a request on no call would have left a card behind.
  await expect(card).toHaveCount(0)
  await expandByKeyboard(page.getByRole("button", { name: "Worked" }))
  await expect(
    page.getByRole("button", { name: /^Ran rm -rf build/ })
  ).toBeVisible()

  // A request no call carries is still answered in the transcript, on its own.
  await input.fill(STANDALONE_PERMISSION_PROMPT)
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(choices).toBeVisible()
  await expect(card).toHaveCount(1)
  await expect(input).toBeVisible()
  await expect(page.getByRole("button", { name: "Send answer" })).toHaveCount(0)

  await choices.getByRole("button", { name: "Allow once" }).click()
  await expect.poll(replies).toEqual([allowed, allowed])
  await expect(page.getByText("Answered: Allow once")).toBeVisible()
  await expect(choices).toHaveCount(0)
})
