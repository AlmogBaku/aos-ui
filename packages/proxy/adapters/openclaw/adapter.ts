import type {
  RuntimeAuthState,
  RuntimeInfo,
  SessionAttachmentStageRequest,
  SessionModelUpdateRequest,
  VisibilityUpdateResponse,
} from "../../../protocol"
import {
  SESSION_CATALOG_MAX_WINDOW,
  SessionWorkspaceCapabilitiesResponseSchema,
} from "../../../protocol"
import type {
  ServerAttachmentStage,
  ServerRunEngine,
  ServerRuntime,
} from "../../core/runtime"
import {
  OpenClawClientConnectionError,
  OpenClawClientRequestError,
  OpenClawClientUnavailableError,
  type OpenClawGatewayClient,
} from "./client"
import { OpenClawContentPublicError } from "./content"
import { openClawCapabilities } from "./capabilities"
import { stageOpenClawChatAttachments } from "./content"
import {
  createOpenClawHistory,
  OpenClawHistoryUnavailableError,
  type OpenClawHistorySubscription,
} from "./history"
import { OpenClawInteractionPublicError } from "./interactions"
import { OpenClawNativePayloadError } from "./native-schemas"
import {
  createOpenClawWorkspace,
  OpenClawWorkspaceOwnershipError,
  OpenClawWorkspaceUnavailableError,
} from "./workspace"

/** A native operation is intentionally absent until its exact V4 semantics are proven. */
export class OpenClawAdapterUnavailableError extends Error {
  constructor() {
    super("OpenClaw operation is unavailable")
    this.name = "OpenClawAdapterUnavailableError"
  }
}

type OpenClawServerAdapterOptions = Readonly<{
  client: OpenClawGatewayClient
  runs: ServerRunEngine
  hiddenAgentIds?: readonly string[]
  subscribeSession: OpenClawHistorySubscription
}>

/**
 * Provider composition only: native identity, subscriptions, and validation
 * remain in the OpenClaw leaves; the coordinator retains admission and runs.
 */
export class OpenClawServerAdapter implements ServerRuntime {
  readonly runs: ServerRunEngine
  readonly #workspace
  readonly #history
  readonly #client: OpenClawGatewayClient
  readonly #subscribeSession: OpenClawHistorySubscription
  #ready?: Promise<void>
  #close?: Promise<void>

  constructor(options: OpenClawServerAdapterOptions) {
    this.runs = options.runs
    this.#client = options.client
    this.#subscribeSession = options.subscribeSession
    this.#workspace = createOpenClawWorkspace({
      client: options.client,
      hiddenAgentIds: options.hiddenAgentIds,
    })
    this.#history = createOpenClawHistory({
      client: options.client,
      authority: this.#workspace,
      subscribeSession: options.subscribeSession,
    })
  }

  resolveSessionId(agentId: string, publicSessionId: string) {
    return this.#workspace.resolveSessionId(agentId, publicSessionId)
  }

  async resolveInvitedSession(
    agentId: string,
    ref: string,
    create?: { readonly firstTurnInstruction?: string }
  ) {
    await this.#start()
    // The pinned Gateway leaves do not prove equivalent native Session creation.
    if (create) return undefined
    return this.#workspace.resolveInvitedSession(agentId, ref)
  }

  publicError(cause: unknown) {
    if (
      cause instanceof OpenClawClientConnectionError &&
      cause.kind !== "unavailable" &&
      cause.kind !== "rate-limited"
    )
      return { code: "runtime_authentication_required", status: 401 } as const
    if (cause instanceof OpenClawClientRequestError && cause.uncertain)
      return { code: "uncertain_mutation", status: 503 } as const
    if (
      cause instanceof OpenClawWorkspaceOwnershipError ||
      (cause instanceof OpenClawInteractionPublicError &&
        cause.code === "AOS_INTERACTION_NOT_FOUND")
    )
      return { code: "not_found", status: 404 } as const
    if (
      cause instanceof OpenClawContentPublicError ||
      (cause instanceof OpenClawInteractionPublicError &&
        cause.code === "AOS_INVALID_INTERACTION")
    )
      return { code: "invalid_request", status: 400 } as const
    if (
      cause instanceof OpenClawClientConnectionError ||
      cause instanceof OpenClawClientRequestError ||
      cause instanceof OpenClawClientUnavailableError ||
      cause instanceof OpenClawWorkspaceUnavailableError ||
      cause instanceof OpenClawHistoryUnavailableError ||
      cause instanceof OpenClawNativePayloadError ||
      cause instanceof OpenClawAdapterUnavailableError ||
      (cause instanceof OpenClawInteractionPublicError &&
        cause.code === "AOS_PROVIDER_INVALID_RESPONSE")
    )
      return { code: "temporarily_unavailable", status: 503 } as const
    return undefined
  }

  async authState(): Promise<RuntimeAuthState> {
    try {
      await this.#start()
      return { status: "authenticated" }
    } catch (error) {
      if (
        error instanceof OpenClawClientConnectionError &&
        error.kind !== "unavailable" &&
        error.kind !== "rate-limited"
      )
        return { status: "authentication-required" }
      return { status: "unavailable", reason: "temporarily-unavailable" }
    }
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    try {
      await this.listAgents()
    } catch (error) {
      if (this.publicError(error)?.code === "runtime_authentication_required")
        throw error
      return this.#runtimeInfo("unavailable")
    }
    return this.#runtimeInfo("ready")
  }

  async listAgents() {
    await this.#start()
    return this.#workspace.listAgents()
  }

  async updateAgentVisibility(
    _agentId: string,
    _visibility: "visible" | "hidden",
    _observedRevision: string
  ): Promise<VisibilityUpdateResponse> {
    void [_agentId, _visibility, _observedRevision]
    throw new OpenClawAdapterUnavailableError()
  }

  async listAllSessions(limit: number, offset: number) {
    await this.#start()
    if (offset + limit > SESSION_CATALOG_MAX_WINDOW)
      throw new OpenClawWorkspaceUnavailableError()
    return this.#workspace.listAllSessions(limit, offset)
  }

  async listSessions(agentId: string, limit: number, offset: number) {
    await this.#start()
    return this.#workspace.listSessions(agentId, limit, offset)
  }

  async history(
    agentId: string,
    runtimeSessionId: string,
    limit: number,
    offset: number
  ) {
    await this.#start()
    return this.#history.history(agentId, runtimeSessionId, limit, offset)
  }

  async getSession(agentId: string, runtimeSessionId: string) {
    await this.#start()
    return this.#workspace.getSession(agentId, runtimeSessionId)
  }

  async createSession(agentId: string, _title?: string): Promise<unknown> {
    void _title
    await this.#start()
    return this.#workspace.createSession(agentId)
  }

  async mutateSession(
    _agentId: string,
    _runtimeSessionId: string,
    _method: "PATCH" | "DELETE",
    _body?: unknown
  ): Promise<void> {
    void [_agentId, _runtimeSessionId, _method, _body]
    throw new OpenClawAdapterUnavailableError()
  }

  async workspaceCapabilities(
    agentId: string,
    publicSessionId: string
  ): Promise<unknown> {
    await this.#start()
    await this.#workspace.getSession(agentId, publicSessionId)
    const policy = this.#client.negotiatedPolicy?.()
    if (!policy) throw new OpenClawAdapterUnavailableError()
    const provider = openClawCapabilities(policy)
    return SessionWorkspaceCapabilitiesResponseSchema.parse({
      agent: {
        identity: { type: "openclaw", provider: "OpenClaw" },
        transport: { streaming: true, resumable: true },
        tools: { supported: true, clientProvided: false },
        reasoning: { supported: true, streaming: true, encrypted: false },
        multimodal: {
          input: {
            image: true,
            audio: false,
            video: false,
            pdf: false,
            file: true,
          },
          output: { image: false, audio: false },
        },
        humanInTheLoop: {
          supported: true,
          approvals: true,
          interventions: false,
          feedback: false,
          interrupts: true,
          approveWithEdits: false,
        },
        custom: { "aos.planActivityType": "PLAN" },
      },
      workspace: {
        slashCommands: {
          status: "unavailable",
          reason: "native-slash-command-catalog-unavailable",
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
        todos: { status: "unavailable", reason: "todo-projection-unavailable" },
        activity: {
          status: "unavailable",
          reason: "activity-projection-unavailable",
        },
      },
      ...provider,
    })
  }

  async models(agentId: string, publicSessionId: string) {
    await this.#start()
    return this.#history.models(agentId, publicSessionId)
  }

  async updateModel(
    _agentId: string,
    _publicSessionId: string,
    _patch: SessionModelUpdateRequest
  ): Promise<unknown> {
    void [_agentId, _publicSessionId, _patch]
    throw new OpenClawAdapterUnavailableError()
  }

  async context(agentId: string, publicSessionId: string) {
    await this.#start()
    return this.#history.context(agentId, publicSessionId)
  }

  async subscribeSessionInvalidation(
    agentId: string,
    publicSessionId: string,
    listener: () => void,
    _reset?: () => void
  ) {
    void _reset
    await this.#start()
    const sessionId = this.resolveSessionId(agentId, publicSessionId)
    if (!sessionId) throw new OpenClawWorkspaceOwnershipError()
    await this.#workspace.getSession(agentId, sessionId)
    return this.#subscribeSession(agentId, sessionId, listener)
  }

  async stageAttachments(
    agentId: string,
    publicSessionId: string,
    attachments: SessionAttachmentStageRequest["attachments"]
  ): Promise<ServerAttachmentStage> {
    await this.#start()
    await this.#workspace.getSession(agentId, publicSessionId)
    const policy = this.#client.negotiatedPolicy?.()
    if (!policy?.attachments) throw new OpenClawAdapterUnavailableError()
    return stageOpenClawChatAttachments(attachments, {
      maxPayload: policy.maxPayload,
      attachments: policy.attachments,
    })
  }

  async artifact(
    _agentId: string,
    _publicSessionId: string,
    _artifactId: string
  ): Promise<{ bytes: Uint8Array; mimeType?: string; filename: string }> {
    void [_agentId, _publicSessionId, _artifactId]
    throw new OpenClawAdapterUnavailableError()
  }

  async transcribe(
    _agentId: string,
    _bytes: Uint8Array,
    _mimeType: string,
    _signal?: AbortSignal
  ): Promise<string> {
    void [_agentId, _bytes, _mimeType, _signal]
    throw new OpenClawAdapterUnavailableError()
  }

  async speak(
    _agentId: string,
    _text: string,
    _signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    void [_agentId, _text, _signal]
    throw new OpenClawAdapterUnavailableError()
  }

  close(): Promise<void> {
    this.#close ??= this.#client.stopAndWait()
    return this.#close
  }

  #start() {
    this.#ready ??= Promise.resolve(this.#client.start())
    return this.#ready
  }

  #runtimeInfo(status: "ready" | "unavailable"): RuntimeInfo {
    const available = status === "ready"
    const operation = available
      ? ({ status: "available" } as const)
      : ({ status: "unavailable", reason: "temporarily-unavailable" } as const)
    const unavailable = (reason: string) =>
      ({ status: "unavailable", reason }) as const
    return {
      runtime: { id: "openclaw", name: "OpenClaw" },
      status,
      capabilities: {
        agentCatalog: operation,
        agentVisibility: unavailable("native-semantic-equivalent-unavailable"),
        sessionCatalog: available
          ? {
              status: "available",
              scope: "workspace",
              order: "recent",
              defaultPageSize: 50,
              maxPageSize: 100,
              maxWindow: SESSION_CATALOG_MAX_WINDOW,
            }
          : unavailable("temporarily-unavailable"),
        sessionHistory: available
          ? {
              status: "available",
              order: "chronological",
              compacted: true,
              loading: "on-open",
              defaultPageSize: 200,
              maxPageSize: 500,
            }
          : unavailable("temporarily-unavailable"),
        sessionDetail: operation,
        sessionCreation: operation,
        sessionTitle: unavailable("native-session-title-unavailable"),
        sessionArchival: unavailable("native-session-archive-unavailable"),
        sessionDeletion: unavailable("native-session-delete-unavailable"),
        sessionRun: operation,
        sessionStop: operation,
        sessionSteer: unavailable("native-active-turn-steering-unavailable"),
        sessionReadState: unavailable("native-session-read-state-unavailable"),
      },
    }
  }
}
