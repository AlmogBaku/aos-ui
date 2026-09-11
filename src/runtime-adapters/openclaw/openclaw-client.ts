import {
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  PROTOCOL_VERSION,
  shouldPauseGatewayReconnect,
  type GatewayProtocolSocketHandlers,
  type GatewayProtocolSocket,
  type HelloOk,
} from "@openclaw/gateway-client/browser"
import type { EventFrame } from "@openclaw/gateway-protocol"
import type { ThreadMessageLike } from "@assistant-ui/react"
import { z } from "zod"
import type {
  AgentSummary,
  RuntimeQuestionRequest,
  SessionStatus,
  WorkspaceActivityEvent,
} from "@/runtime-adapters/contracts"
import { createOpenClawDeviceAuth } from "./openclaw-auth"

const object = z.record(z.string(), z.unknown())
const agentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    kind: z.string().optional(),
    identity: z
      .object({ name: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
const sessionSchema = z
  .object({
    key: z.string().min(1),
    archived: z.boolean().optional(),
    agentId: z.string().optional(),
    label: z.string().optional(),
    displayName: z.string().optional(),
    updatedAt: z.number().nullable().optional(),
    hasActiveRun: z.boolean().optional(),
    activeRunIds: z.array(z.string()).nullable().optional(),
    model: z.string().optional(),
    contextTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  })
  .passthrough()
const questionSchema = z
  .object({
    id: z.string(),
    sessionKey: z.string(),
    agentId: z.string().optional(),
    status: z.enum(["pending", "answered", "cancelled", "expired"]),
    questions: z.array(
      z.object({
        questionId: z.string(),
        header: z.string(),
        question: z.string(),
        options: z.array(
          z.object({ label: z.string(), description: z.string().optional() })
        ),
        multiSelect: z.boolean().optional(),
        isOther: z.boolean().optional(),
        isSecret: z.boolean().optional(),
      })
    ),
    expiresAtMs: z.number(),
  })
  .passthrough()
type NativeQuestion = z.infer<typeof questionSchema>
const approvalSchema = z
  .object({
    id: z.string(),
    request: z
      .object({
        sessionKey: z.string(),
        agentId: z.string().nullable().optional(),
        command: z.string(),
        allowedDecisions: z
          .array(z.enum(["allow-once", "allow-always", "deny"]))
          .optional(),
      })
      .passthrough(),
    createdAtMs: z.number(),
    expiresAtMs: z.number(),
  })
  .passthrough()
export type OpenClawApproval = z.infer<typeof approvalSchema>
export type OpenClawAttachment = {
  type?: string
  mimeType?: string
  fileName?: string
  content: string
  sizeBytes?: number
}
export type OpenClawSession = {
  threadId: string
  agentId: string
  title: string
  archived?: boolean
  updatedAt: string
  status: SessionStatus
  messages: ThreadMessageLike[]
  running: boolean
  loading: boolean
  runId?: string
  activeRunIds?: string[]
  model?: string
  contextTokens?: number
  totalTokens?: number
}
export type OpenClawSnapshot = {
  revision: number
  connection: "disconnected" | "connecting" | "ready" | "blocked"
  error?: Error
  connectionDetails?: unknown
  agents: AgentSummary[]
  sessions: OpenClawSession[]
}
export type OpenClawClientOptions = {
  gatewayUrl: string
  creatorAgentId?: string
  token?: string
  password?: string
  createSocket?: (
    handlers: GatewayProtocolSocketHandlers
  ) => GatewayProtocolSocket
  deviceAuth?: ConstructorParameters<
    typeof GatewayBrowserDeviceAuthLifecycle
  >[0]
  onError?: (error: Error) => void
}

function message(
  raw: unknown,
  fallbackId: string
): ThreadMessageLike | undefined {
  const parsed = object.safeParse(raw)
  if (!parsed.success) return
  const row = parsed.data
  if (row.role !== "assistant" && row.role !== "user" && row.role !== "system")
    return
  const native = object.safeParse(row.__openclaw)
  const id =
    native.success && typeof native.data.id === "string"
      ? native.data.id
      : typeof row.id === "string"
        ? row.id
        : fallbackId
  const parts: Exclude<ThreadMessageLike["content"], string>[number][] = []
  if (typeof row.content === "string")
    parts.push({ type: "text", text: row.content })
  if (Array.isArray(row.content))
    for (const part of row.content) {
      const value = object.safeParse(part)
      if (!value.success) continue
      if (value.data.type === "text" && typeof value.data.text === "string")
        parts.push({ type: "text", text: value.data.text })
      else if (
        value.data.type === "thinking" &&
        typeof value.data.thinking === "string"
      )
        parts.push({ type: "reasoning", text: value.data.thinking })
      else if (
        value.data.type === "toolCall" &&
        typeof value.data.id === "string" &&
        typeof value.data.name === "string"
      ) {
        const args = z
          .record(z.string(), z.json())
          .safeParse(value.data.arguments)
        parts.push({
          type: "tool-call",
          toolCallId: value.data.id,
          toolName: value.data.name,
          args: args.success ? args.data : {},
          argsText: JSON.stringify(value.data.arguments ?? {}),
        })
      } else parts.push({ type: "text", text: JSON.stringify(value.data) })
    }
  return { id, role: row.role, content: parts }
}

export class OpenClawClient {
  private snapshot: OpenClawSnapshot = {
    revision: 0,
    connection: "disconnected",
    agents: [],
    sessions: [],
  }
  private listeners = new Set<() => void>()
  private activityListeners = new Set<(event: WorkspaceActivityEvent) => void>()
  private questions = new Map<string, NativeQuestion>()
  private approvals = new Map<string, OpenClawApproval>()
  private catalogListeners = new Set<() => void>()
  private rosterSubscribed = false
  private resolvedInteractions = new Set<string>()
  private sequences = new Map<string, number>()
  private terminalRuns = new Set<string>()
  private selected = new Set<string>()
  private historyVersions = new Map<string, number>()
  private hello?: HelloOk
  private ready?: Promise<void>
  private resolveReady?: () => void
  private rejectReady?: (error: Error) => void
  private stopped = false
  private readonly wire: GatewayProtocolClient<
    Awaited<ReturnType<GatewayBrowserDeviceAuthLifecycle["buildPlan"]>>
  >
  readonly capabilities = {
    agentCatalog: false,
    agentVisibilityUpdates: false,
    agentUpdates: false,
    todos: false,
    agentCreation: false,
    activityEvents: true,
  }

  constructor(readonly options: OpenClawClientOptions) {
    const url = new URL(options.gatewayUrl)
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "OpenClaw requires a credential-free ws:// or wss:// Gateway URL"
      )
    const auth = new GatewayBrowserDeviceAuthLifecycle(
      options.deviceAuth ?? createOpenClawDeviceAuth(options.gatewayUrl)
    )
    const client = {
      id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
      displayName: "AOS",
      version: "0.0.1",
      platform: "web",
      mode: "webchat" as const,
    }
    this.wire = new GatewayProtocolClient({
      createRequestId: () => crypto.randomUUID(),
      createSocket:
        options.createSocket ??
        ((handlers) => {
          const socket = new WebSocket(options.gatewayUrl)
          socket.addEventListener("open", handlers.open)
          socket.addEventListener("message", (event) => {
            if (typeof event.data === "string") handlers.message(event.data)
          })
          socket.addEventListener("close", (event) =>
            handlers.close(event.code, event.reason)
          )
          socket.addEventListener("error", () =>
            handlers.error(new Error("OpenClaw WebSocket connection failed"))
          )
          return {
            isOpen: () => socket.readyState === WebSocket.OPEN,
            send: (data) => socket.send(data),
            close: (code, reason) => socket.close(code, reason),
          }
        }),
      buildConnectPlan: ({ nonce, challengeTs }) =>
        auth.buildPlan({
          client,
          role: "operator",
          defaultScopes: [
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.questions",
          ],
          token: options.token,
          password: options.password,
          nonce,
          challengeTs,
        }),
      buildConnectParams: (plan) => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: plan.role,
        scopes: plan.scopes,
        auth: plan.auth,
        device: plan.device,
        caps: [
          GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
          GATEWAY_CLIENT_CAPS.EXEC_APPROVALS,
        ],
      }),
      onConnectHello: (hello, context) => {
        void auth
          .acceptHello(hello, context.plan)
          .catch((error: unknown) => this.fail(error))
      },
      onHello: (hello) => {
        this.hello = hello
        this.rosterSubscribed = false
        this.patch({
          connection: "connecting",
          error: undefined,
          connectionDetails: undefined,
        })
        void this.refresh()
          .then(async () => {
            await Promise.all(
              [...this.selected].map((key) => this.loadHistory(key))
            )
            this.patch({ connection: "ready" })
            this.resolveReady?.()
          })
          .catch((error: unknown) => this.fail(error))
      },
      onConnectFailure: (error) => {
        const pause = shouldPauseGatewayReconnect({
          details: error.details,
          protocolMismatchIsTerminal: true,
          tokenMismatchIsTerminal: true,
        })
        this.patch({
          connection: "blocked",
          error,
          connectionDetails: error.details,
        })
        this.rejectReady?.(error)
        return {
          closeCode: 1008,
          closeReason: "Authentication failed",
          stop: pause,
          error,
        }
      },
      resolveClose: ({ connectFailure }) => ({
        retry:
          !this.stopped &&
          !(
            connectFailure &&
            shouldPauseGatewayReconnect({
              details: object.safeParse(connectFailure.error).success
                ? Reflect.get(connectFailure.error, "details")
                : undefined,
              protocolMismatchIsTerminal: true,
              tokenMismatchIsTerminal: true,
            })
          ),
        notify: true,
      }),
      onClose: () => {
        if (this.snapshot.connection !== "blocked")
          this.patch({ connection: "disconnected" })
      },
      onConnectError: (error) => this.fail(error),
      onEvent: (event) => this.onEvent(event),
      onGap: () => {
        void this.recover().catch((error: unknown) => this.fail(error))
      },
      handshake: { mode: "require-challenge", timeoutMs: 10000 },
      reconnect: { initialMs: 1000, multiplier: 1.5, maxMs: 30000 },
    })
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  subscribeActivity = (listener: (event: WorkspaceActivityEvent) => void) => {
    this.activityListeners.add(listener)
    return () => {
      this.activityListeners.delete(listener)
    }
  }
  subscribeCatalog = (listener: () => void) => {
    this.catalogListeners.add(listener)
    return () => {
      this.catalogListeners.delete(listener)
    }
  }
  session(key: string) {
    return this.snapshot.sessions.find((entry) => entry.threadId === key)
  }
  supports(method: string) {
    return this.hello?.features.methods.includes(method) ?? false
  }
  start() {
    if (!this.ready) {
      this.stopped = false
      this.ready = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve
        this.rejectReady = reject
      })
      this.patch({ connection: "connecting" })
      this.wire.start()
    }
    return this.ready
  }
  stop() {
    this.stopped = true
    this.wire.stop()
    this.ready = undefined
    this.patch({ connection: "disconnected" })
  }
  async request(method: string, params: unknown = {}) {
    if (!this.supports(method))
      throw new Error(`OpenClaw does not support ${method}`)
    return this.wire.request(method, params)
  }
  private patch(patch: Partial<OpenClawSnapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
    }
    this.listeners.forEach((listener) => listener())
  }
  private fail(reason: unknown) {
    if (this.stopped) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.patch({ error })
    this.rejectReady?.(error)
    this.options.onError?.(error)
  }
  private updateSession(key: string, update: Partial<OpenClawSession>) {
    this.patch({
      sessions: this.snapshot.sessions.map((session) =>
        session.threadId === key ? { ...session, ...update } : session
      ),
    })
  }
  private requireSession(key: string) {
    const session = this.session(key)
    if (!session) throw new Error("Unknown OpenClaw Session")
    return session
  }
  private owner(key: string, explicit?: string) {
    const keyOwner = /^agent:([^:]+):/.exec(key)?.[1]
    if (keyOwner && explicit && keyOwner !== explicit)
      throw new Error("OpenClaw Session ownership mismatch")
    const owner = explicit ?? keyOwner
    if (!owner || !this.snapshot.agents.some((agent) => agent.id === owner))
      throw new Error("OpenClaw Session has no known Agent owner")
    return owner
  }
  async refresh() {
    const result = z
      .object({ agents: z.array(agentSchema) })
      .parse(await this.request("agents.list"))
    this.patch({
      agents: result.agents
        .filter(
          (agent) =>
            agent.kind !== "system" || agent.id === this.options.creatorAgentId
        )
        .map((agent): AgentSummary => ({
          kind: "ready",
          id: agent.id,
          name: agent.identity?.name ?? agent.name ?? agent.id,
          status: "unknown",
          ...(agent.id === this.options.creatorAgentId
            ? { role: "creator", visibility: "hidden" }
            : {}),
        })),
    })
    const subscribe =
      !this.rosterSubscribed && this.supports("sessions.subscribe")
    this.rosterSubscribed = true
    let raw = await this.request(
      subscribe ? "sessions.subscribe" : "sessions.list",
      { limit: 100, ownerFirst: true }
    )
    if (subscribe)
      raw =
        object.parse(raw).list ??
        (await this.request("sessions.list", { limit: 100 }))
    const listSchema = z.object({
      sessions: z.array(sessionSchema),
      hasMore: z.boolean().optional(),
      nextOffset: z.number().int().nonnegative().optional(),
    })
    let page = listSchema.parse(raw)
    const rows = new Map(page.sessions.map((session) => [session.key, session]))
    let offset = 0
    while (page.hasMore) {
      if (page.nextOffset === undefined || page.nextOffset <= offset)
        throw new Error("OpenClaw returned an invalid Session page cursor")
      offset = page.nextOffset
      page = listSchema.parse(
        await this.request("sessions.list", { limit: 100, offset })
      )
      for (const session of page.sessions) rows.set(session.key, session)
    }
    this.patch({
      sessions: [...rows.values()]
        .filter(
          (row) =>
            !result.agents.some(
              (agent) =>
                agent.kind === "system" &&
                agent.id !== this.options.creatorAgentId &&
                (row.agentId ?? /^agent:([^:]+):/.exec(row.key)?.[1]) ===
                  agent.id
            )
        )
        .map((row) => {
          const previous = this.session(row.key)
          const running = Array.isArray(row.activeRunIds)
            ? row.activeRunIds.length > 0
            : row.hasActiveRun === true
          return {
            threadId: row.key,
            agentId: this.owner(row.key, row.agentId),
            title: row.label ?? row.displayName ?? row.key,
            archived: row.archived,
            updatedAt: new Date(row.updatedAt ?? 0).toISOString(),
            messages: previous?.messages ?? [],
            loading: previous?.loading ?? false,
            running,
            status: running
              ? "running"
              : row.hasActiveRun === false || Array.isArray(row.activeRunIds)
                ? "idle"
                : "unknown",
            activeRunIds: row.activeRunIds ?? undefined,
            runId: previous?.runId,
            model: row.model,
            contextTokens: row.contextTokens,
            totalTokens: row.totalTokens,
          }
        }),
    })
    if (this.supports("question.list")) {
      const list = z
        .object({ questions: z.array(questionSchema) })
        .parse(await this.request("question.list"))
      for (const question of list.questions) this.acceptQuestion(question)
    }
    if (this.supports("exec.approval.list")) {
      const approvals = z
        .array(approvalSchema)
        .parse(await this.request("exec.approval.list"))
      for (const approval of approvals) this.acceptApproval(approval)
    }
    this.patch()
    this.catalogListeners.forEach((listener) => listener())
  }
  private async recover() {
    await this.refresh()
    await Promise.all([...this.selected].map((key) => this.loadHistory(key)))
  }
  async loadHistory(key: string) {
    const session = this.requireSession(key)
    this.selected.add(key)
    const version = (this.historyVersions.get(key) ?? 0) + 1
    this.historyVersions.set(key, version)
    this.updateSession(key, { loading: true })
    try {
      if (this.supports("sessions.messages.subscribe"))
        await this.request("sessions.messages.subscribe", { key })
      const raw = z
        .object({
          messages: z.array(z.unknown()),
          inFlightRun: z
            .object({ runId: z.string(), text: z.string().optional() })
            .nullable()
            .optional(),
          sessionInfo: z
            .object({
              hasActiveRun: z.boolean().optional(),
              activeRunIds: z.array(z.string()).optional(),
            })
            .optional(),
        })
        .passthrough()
        .parse(
          await this.request("chat.history", {
            sessionKey: key,
            agentId: session.agentId,
          })
        )
      if (this.historyVersions.get(key) !== version) return
      let messages = raw.messages.flatMap((row, index) => {
        const converted = message(row, `${key}:${index}`)
        return converted ? [converted] : []
      })
      for (const row of raw.messages) {
        const result = object.safeParse(row)
        if (
          !result.success ||
          result.data.role !== "toolResult" ||
          typeof result.data.toolCallId !== "string"
        )
          continue
        messages = messages.map((assistant) =>
          typeof assistant.content === "string"
            ? assistant
            : {
                ...assistant,
                content: assistant.content.map((part) =>
                  part.type === "tool-call" &&
                  part.toolCallId === result.data.toolCallId
                    ? {
                        ...part,
                        result: result.data.details ?? result.data.content,
                        isError: result.data.isError === true,
                      }
                    : part
                ),
              }
        )
      }
      if (raw.inFlightRun)
        messages.push({
          id: raw.inFlightRun.runId,
          role: "assistant",
          content: [{ type: "text", text: raw.inFlightRun.text ?? "" }],
          status: { type: "running" },
        })
      const activeRunIds = raw.sessionInfo?.activeRunIds
      const running =
        Boolean(raw.inFlightRun) ||
        (activeRunIds
          ? activeRunIds.length > 0
          : raw.sessionInfo?.hasActiveRun === true)
      this.updateSession(key, {
        messages,
        runId: raw.inFlightRun?.runId,
        activeRunIds,
        running,
        status: running
          ? "running"
          : activeRunIds || raw.sessionInfo?.hasActiveRun === false
            ? "idle"
            : "unknown",
        loading: false,
      })
    } catch (error) {
      this.updateSession(key, { loading: false, status: "unknown" })
      throw error
    }
  }
  async createSession(agentId: string, title?: string) {
    if (!this.snapshot.agents.some((agent) => agent.id === agentId))
      throw new Error("Unknown OpenClaw Agent")
    const result = z.object({ key: z.string(), ok: z.literal(true) }).parse(
      await this.request("sessions.create", {
        agentId,
        ...(title ? { label: title } : {}),
      })
    )
    this.owner(result.key, agentId)
    this.patch({
      sessions: [
        ...this.snapshot.sessions,
        {
          threadId: result.key,
          agentId,
          title: title ?? result.key,
          updatedAt: new Date().toISOString(),
          status: "idle",
          running: false,
          loading: false,
          messages: [],
        },
      ],
    })
    return { threadId: result.key }
  }
  async submit(key: string, text: string, attachments?: OpenClawAttachment[]) {
    const session = this.requireSession(key)
    for (const attachment of attachments ?? []) {
      if (typeof attachment.content !== "string")
        throw new Error("OpenClaw attachment content must be base64")
      const bytes = atob(attachment.content).length
      const limits = this.hello?.policy.attachments
      const ceiling = attachment.mimeType?.startsWith("image/")
        ? limits?.maxImageBytes
        : limits?.maxBytes
      if (ceiling && bytes > ceiling)
        throw new Error("OpenClaw attachment exceeds Gateway limit")
    }
    const params = {
      sessionKey: key,
      agentId: session.agentId,
      message: text,
      idempotencyKey: crypto.randomUUID(),
      ...(attachments?.length ? { attachments } : {}),
    }
    if (
      new TextEncoder().encode(
        JSON.stringify({
          type: "req",
          id: crypto.randomUUID(),
          method: "chat.send",
          params,
        })
      ).length > (this.hello?.policy.maxPayload ?? Infinity)
    )
      throw new Error(
        "OpenClaw attachment request exceeds Gateway payload limit"
      )
    const response = z
      .object({ runId: z.string() })
      .passthrough()
      .parse(await this.request("chat.send", params))
    const current = this.requireSession(key)
    const user: ThreadMessageLike = {
      id: params.idempotencyKey,
      role: "user",
      content: [{ type: "text", text }],
    }
    const runIndex = current.messages.findIndex(
      (message) => message.id === response.runId
    )
    const messages = [...current.messages]
    messages.splice(runIndex < 0 ? messages.length : runIndex, 0, user)
    this.updateSession(key, {
      messages,
      ...(!this.terminalRuns.has(`${key}:${response.runId}`)
        ? { runId: response.runId, running: true, status: "running" }
        : {}),
    })
  }
  async listModels() {
    const result = z
      .object({
        models: z.array(
          z
            .object({ id: z.string(), name: z.string(), provider: z.string() })
            .passthrough()
        ),
      })
      .parse(await this.request("models.list"))
    return result.models.map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: model.name,
      group: model.provider,
    }))
  }
  async selectModel(key: string, model: string) {
    const session = this.requireSession(key)
    await this.request("sessions.patch", {
      key,
      agentId: session.agentId,
      model,
    })
    await this.refresh()
  }
  async synthesize(text: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const result = z
      .object({ audioBase64: z.string(), mimeType: z.string().optional() })
      .passthrough()
      .parse(
        await this.request(
          this.supports("talk.speak") ? "talk.speak" : "tts.speak",
          { text }
        )
      )
    signal.throwIfAborted()
    return new Blob(
      [Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0))],
      { type: result.mimeType ?? "audio/mpeg" }
    )
  }
  async stopRun(key: string) {
    const session = this.requireSession(key)
    if (!session.runId) throw new Error("OpenClaw has no exact run to stop")
    await this.request("chat.abort", {
      sessionKey: key,
      agentId: session.agentId,
      runId: session.runId,
    })
  }
  pendingQuestions(key: string): RuntimeQuestionRequest[] {
    return [...this.questions.values()]
      .filter(
        (q) =>
          q.sessionKey === key &&
          q.status === "pending" &&
          q.expiresAtMs > Date.now() &&
          !q.questions.some((item) => item.isSecret)
      )
      .map((q) => ({
        kind: "question",
        requestId: q.id,
        sessionId: key,
        questions: q.questions.map((item) => ({
          id: item.questionId,
          header: item.header,
          prompt: item.question,
          options: item.options,
          multiple: item.multiSelect,
          custom: item.isOther,
        })),
      }))
  }
  async answerQuestion(key: string, id: string, answers: string[][] | null) {
    const question = this.questions.get(id)
    if (
      !question ||
      question.sessionKey !== key ||
      !this.pendingQuestions(key).some((q) => q.requestId === id)
    )
      throw new Error("OpenClaw question is unavailable")
    if (answers && answers.length !== question.questions.length)
      throw new Error("OpenClaw question answer count mismatch")
    await this.request(
      "question.resolve",
      answers
        ? {
            id,
            answers: {
              answers: Object.fromEntries(
                question.questions.map((q, index) => [
                  q.questionId,
                  answers[index],
                ])
              ),
            },
          }
        : { id, cancel: true }
    )
    this.resolvedInteractions.add(id)
    this.questions.delete(id)
    this.resolveAttention(key, id)
    this.patch()
  }
  private acceptQuestion(question: NativeQuestion) {
    const session = this.session(question.sessionKey)
    if (
      !session ||
      (question.agentId && session.agentId !== question.agentId) ||
      this.resolvedInteractions.has(question.id)
    )
      return
    if (question.status === "pending") {
      const fresh = !this.questions.has(question.id)
      this.questions.set(question.id, question)
      this.updateSession(question.sessionKey, { status: "waiting-for-input" })
      if (fresh)
        this.emitAttention(question.sessionKey, question.id, "question")
    } else {
      this.questions.delete(question.id)
      this.resolvedInteractions.add(question.id)
    }
  }
  pendingApprovals(key: string) {
    return [...this.approvals.values()].filter(
      (approval) =>
        approval.request.sessionKey === key && approval.expiresAtMs > Date.now()
    )
  }
  private acceptApproval(approval: OpenClawApproval) {
    const session = this.session(approval.request.sessionKey)
    if (
      !session ||
      (approval.request.agentId &&
        session.agentId !== approval.request.agentId) ||
      this.resolvedInteractions.has(approval.id)
    )
      return
    const fresh = !this.approvals.has(approval.id)
    this.approvals.set(approval.id, approval)
    this.updateSession(approval.request.sessionKey, {
      status: "waiting-for-input",
    })
    if (fresh)
      this.emitAttention(approval.request.sessionKey, approval.id, "permission")
  }
  async answerApproval(
    key: string,
    id: string,
    decision: "allow-once" | "allow-always" | "deny"
  ) {
    const approval = this.pendingApprovals(key).find(
      (approval) => approval.id === id
    )
    if (!approval) throw new Error("OpenClaw approval is unavailable")
    if (
      !(approval.request.allowedDecisions ?? ["allow-once", "deny"]).includes(
        decision
      )
    )
      throw new Error("OpenClaw approval decision is unavailable")
    await this.request("exec.approval.resolve", { id, decision })
    this.resolvedInteractions.add(id)
    this.approvals.delete(id)
    this.resolveAttention(key, id)
    this.patch()
  }
  private emitAttention(
    key: string,
    id: string,
    kind?: "question" | "permission"
  ) {
    const session = this.requireSession(key)
    const base = {
      id: `${id}:${kind ?? "resolved"}`,
      agentId: session.agentId,
      threadId: key,
      occurredAt: new Date().toISOString(),
      requestId: id,
    }
    const event: WorkspaceActivityEvent = kind
      ? { ...base, type: "attention-requested", attentionKind: kind }
      : { ...base, type: "attention-resolved" }
    this.activityListeners.forEach((listener) => listener(event))
  }
  private resolveAttention(key: string, id: string) {
    const session = this.session(key)
    if (!session) return
    this.emitAttention(key, id)
    this.updateSession(key, {
      status:
        this.pendingQuestions(key).length || this.pendingApprovals(key).length
          ? "waiting-for-input"
          : session.running
            ? "running"
            : "unknown",
    })
  }
  private onEvent(event: EventFrame) {
    try {
      if (event.event === "agent") {
        this.onAgentEvent(event.payload)
        return
      }
      if (event.event === "sessions.changed") {
        void this.refresh().catch((error: unknown) => this.fail(error))
        return
      }
      if (event.event === "question.requested") {
        this.acceptQuestion(questionSchema.parse(event.payload))
        this.patch()
        return
      }
      if (event.event === "question.resolved") {
        const data = z
          .object({ id: z.string() })
          .passthrough()
          .parse(event.payload)
        const key = this.questions.get(data.id)?.sessionKey
        this.resolvedInteractions.add(data.id)
        this.questions.delete(data.id)
        if (key) this.resolveAttention(key, data.id)
        this.patch()
        return
      }
      if (event.event === "exec.approval.requested") {
        this.acceptApproval(approvalSchema.parse(event.payload))
        this.patch()
        return
      }
      if (event.event === "exec.approval.resolved") {
        const data = z
          .object({ id: z.string() })
          .passthrough()
          .parse(event.payload)
        const key = this.approvals.get(data.id)?.request.sessionKey
        this.resolvedInteractions.add(data.id)
        this.approvals.delete(data.id)
        if (key) this.resolveAttention(key, data.id)
        this.patch()
        return
      }
      if (event.event === "session.message") {
        const data = object.parse(event.payload)
        if (
          typeof data.sessionKey === "string" &&
          this.selected.has(data.sessionKey)
        )
          void this.loadHistory(data.sessionKey).catch((error: unknown) =>
            this.fail(error)
          )
        return
      }
      if (event.event !== "chat") return
      const data = z
        .object({
          sessionKey: z.string(),
          agentId: z.string().optional(),
          runId: z.string(),
          seq: z.number().int().nonnegative(),
          state: z.enum(["status", "delta", "final", "error", "aborted"]),
          deltaText: z.string().optional(),
          replace: z.boolean().optional(),
          message: z.unknown().optional(),
          errorMessage: z.string().optional(),
        })
        .passthrough()
        .parse(event.payload)
      const session = this.session(data.sessionKey)
      if (!session || (data.agentId && data.agentId !== session.agentId)) return
      const sequenceKey = `${data.sessionKey}:${data.runId}`
      if (this.terminalRuns.has(sequenceKey)) return
      const previous = this.sequences.get(sequenceKey)
      if (previous !== undefined && data.seq <= previous) return
      this.sequences.set(sequenceKey, data.seq)
      if (previous !== undefined && data.seq > previous + 1) {
        void this.loadHistory(data.sessionKey).catch((error: unknown) =>
          this.fail(error)
        )
        return
      }
      this.historyVersions.set(
        data.sessionKey,
        (this.historyVersions.get(data.sessionKey) ?? 0) + 1
      )
      const running = data.state === "delta" || data.state === "status"
      if (!running) this.terminalRuns.add(sequenceKey)
      const old = session.messages.find((row) => row.id === data.runId)
      const oldText = Array.isArray(old?.content)
        ? old.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
        : ""
      const converted = message(data.message, data.runId)
      const content = converted?.content ?? [
        ...(Array.isArray(old?.content)
          ? old.content.filter((part) => part.type !== "text")
          : []),
        {
          type: "text" as const,
          text: data.replace
            ? (data.deltaText ?? "")
            : oldText + (data.deltaText ?? ""),
        },
      ]
      const row: ThreadMessageLike = {
        id: data.runId,
        role: "assistant",
        content,
        status: running
          ? { type: "running" }
          : data.state === "error"
            ? { type: "incomplete", reason: "error", error: data.errorMessage }
            : data.state === "aborted"
              ? { type: "incomplete", reason: "cancelled" }
              : { type: "complete", reason: "stop" },
      }
      const messages = old
        ? session.messages.map((item) => (item.id === data.runId ? row : item))
        : [...session.messages, row]
      const controlsSession = !session.runId || session.runId === data.runId
      this.updateSession(data.sessionKey, {
        messages,
        loading: false,
        ...(controlsSession
          ? {
              running,
              runId: running ? data.runId : undefined,
              status: running
                ? "running"
                : data.state === "error"
                  ? "failed"
                  : "idle",
            }
          : {}),
      })
      if (previous === undefined || !running) {
        const activity: WorkspaceActivityEvent = {
          id: `${sequenceKey}:${data.seq}`,
          agentId: session.agentId,
          threadId: session.threadId,
          occurredAt: new Date().toISOString(),
          type: running
            ? "run-started"
            : data.state === "error"
              ? "run-failed"
              : "run-finished",
          lifecycleId: data.runId,
        }
        this.activityListeners.forEach((listener) => listener(activity))
      }
    } catch (error) {
      this.fail(error)
    }
  }
  private onAgentEvent(raw: unknown) {
    const event = z
      .object({
        runId: z.string(),
        seq: z.number().int(),
        stream: z.string(),
        ts: z.number(),
        data: object,
      })
      .passthrough()
      .parse(raw)
    const owners = this.snapshot.sessions.filter(
      (session) => session.runId === event.runId
    )
    if (owners.length !== 1) return
    const session = owners[0]!
    const key = `${session.threadId}:${event.runId}`
    if (this.terminalRuns.has(key)) return
    const previous = this.sequences.get(`agent:${key}`)
    if (previous !== undefined && event.seq <= previous) return
    this.sequences.set(`agent:${key}`, event.seq)
    if (previous !== undefined && event.seq > previous + 1) {
      void this.loadHistory(session.threadId).catch((error: unknown) =>
        this.fail(error)
      )
      return
    }
    if (
      event.stream === "lifecycle" &&
      (event.data.phase === "end" || event.data.phase === "error")
    ) {
      void this.loadHistory(session.threadId).catch((error: unknown) =>
        this.fail(error)
      )
      return
    }
    if (event.stream !== "tool") return
    const data = z
      .object({
        toolCallId: z.string(),
        name: z.string(),
        phase: z.enum(["start", "update", "result"]),
        args: z.record(z.string(), z.json()).optional(),
        result: z.unknown().optional(),
        partialResult: z.unknown().optional(),
        isError: z.boolean().optional(),
      })
      .passthrough()
      .parse(event.data)
    const old = session.messages.find((message) => message.id === event.runId)
    const content =
      typeof old?.content === "string"
        ? [{ type: "text" as const, text: old.content }]
        : [...(old?.content ?? [])]
    const previousTool = content.find(
      (part) => part.type === "tool-call" && part.toolCallId === data.toolCallId
    )
    const args =
      data.args ?? (previousTool?.type === "tool-call" ? previousTool.args : {})
    const tool = {
      type: "tool-call" as const,
      toolCallId: data.toolCallId,
      toolName: data.name,
      args,
      argsText: JSON.stringify(args),
      ...(data.phase === "result"
        ? { result: data.result, isError: data.isError }
        : {}),
    }
    const index = content.findIndex(
      (part) => part.type === "tool-call" && part.toolCallId === data.toolCallId
    )
    if (index < 0) content.push(tool)
    else content[index] = tool
    const message: ThreadMessageLike = {
      id: event.runId,
      role: "assistant",
      content,
      status: { type: "running" },
    }
    this.updateSession(session.threadId, {
      messages: old
        ? session.messages.map((row) =>
            row.id === event.runId ? message : row
          )
        : [...session.messages, message],
    })
  }
}
