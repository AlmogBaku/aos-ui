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
  ServerMcpApps,
  ServerTurnEngine,
  ServerRuntime,
  SessionPatch,
} from "../../core/runtime"
import {
  OpenClawClientConnectionError,
  OpenClawClientRequestError,
  OpenClawClientUnavailableError,
  type OpenClawGatewayClient,
} from "./client"
import {
  artifactFilename,
  artifactMime,
  downloadBytes,
  isNativeArtifactId,
  isReceiptArtifactId,
  OpenClawArtifactUnavailableError,
  OpenClawArtifactUnreadableError,
  sessionFileBytes,
} from "./artifacts"
import { OpenClawContentPublicError } from "./content"
import { openClawCapabilities } from "./capabilities"
import { stageOpenClawChatAttachments } from "./content"
import {
  createOpenClawHistory,
  OpenClawHistoryUnavailableError,
  type OpenClawHistorySubscription,
} from "./history"
import { OpenClawInteractionPublicError } from "./interactions"
import { createOpenClawMcpApps } from "./mcp-apps"
import {
  createOpenClawMcpToolNames,
  type OpenClawMcpToolNames,
} from "./mcp-tool-names"
import {
  OpenClawNativePayloadError,
  openClawArtifactDownloadParams,
  openClawSessionFileParams,
  parseOpenClawArtifactDownload,
  parseOpenClawSessionFile,
} from "./native-schemas"
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

/**
 * One artifact read. The gateway refuses a missing, unknown, or unsupported
 * artifact without saying which, so every refusal reads as unreadable.
 */
async function readable(read: () => Promise<unknown>) {
  try {
    return await read()
  } catch (error) {
    if (
      error instanceof OpenClawClientRequestError &&
      error.kind === "rejected"
    )
      throw new OpenClawArtifactUnreadableError()
    throw error
  }
}

type OpenClawServerAdapterOptions = Readonly<{
  client: OpenClawGatewayClient
  turns: ServerTurnEngine
  hiddenAgentIds?: readonly string[]
  subscribeSession: OpenClawHistorySubscription
  /** The gateway's HTTP origin, where a ticketed media download resolves. */
  gatewayOrigin?: string
  fetch?: typeof fetch
  /** Shared with the turn engine so live and stored tool names agree. */
  mcpToolNames?: OpenClawMcpToolNames
}>

/**
 * Provider composition only: native identity, subscriptions, and validation
 * remain in the OpenClaw leaves; the coordinator retains admission and turns.
 */
export class OpenClawServerAdapter implements ServerRuntime {
  readonly turns: ServerTurnEngine
  readonly mcpApps: ServerMcpApps
  readonly #workspace
  readonly #history
  readonly #client: OpenClawGatewayClient
  readonly #subscribeSession: OpenClawHistorySubscription
  readonly #gatewayOrigin?: string
  readonly #fetch: typeof fetch
  #ready?: Promise<void>
  #close?: Promise<void>

  constructor(options: OpenClawServerAdapterOptions) {
    this.turns = options.turns
    this.#client = options.client
    this.#subscribeSession = options.subscribeSession
    this.#gatewayOrigin = options.gatewayOrigin
    this.#fetch = options.fetch ?? fetch
    this.#workspace = createOpenClawWorkspace({
      client: options.client,
      hiddenAgentIds: options.hiddenAgentIds,
    })
    this.#history = createOpenClawHistory({
      client: options.client,
      authority: this.#workspace,
      subscribeSession: options.subscribeSession,
      mcpToolNames:
        options.mcpToolNames ?? createOpenClawMcpToolNames(options.client),
    })
    this.mcpApps = createOpenClawMcpApps({
      client: options.client,
      authority: {
        getSession: (agentId, sessionKey) =>
          this.#workspace.getSession(agentId, sessionKey),
        mcpAppViewId: (agentId, sessionKey, toolCallId) =>
          this.#history.mcpAppViewId(agentId, sessionKey, toolCallId),
      },
      start: () => this.#start(),
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
      // The artifact is still authoritative, but OpenClaw cannot read it:
      // unlike a 503, "not found" never invites a retry that cannot succeed.
      cause instanceof OpenClawArtifactUnreadableError ||
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
      cause instanceof OpenClawArtifactUnavailableError ||
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

  async updateSession(
    agentId: string,
    runtimeSessionId: string,
    patch: SessionPatch
  ): Promise<void> {
    await this.#start()
    // The native patch owns each flag's side effects; AOS sends one at a time.
    await this.#workspace.updateSession(agentId, runtimeSessionId, patch)
  }

  async deleteSession(agentId: string, runtimeSessionId: string) {
    await this.#start()
    await this.#workspace.deleteSession(agentId, runtimeSessionId)
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
    agentId: string,
    publicSessionId: string,
    artifactId: string
  ): Promise<{ bytes: Uint8Array; mimeType?: string; filename: string }> {
    await this.#start()
    await this.#workspace.getSession(agentId, publicSessionId)
    return isReceiptArtifactId(artifactId)
      ? this.#receiptArtifact(agentId, publicSessionId, artifactId)
      : this.#nativeArtifact(agentId, publicSessionId, artifactId)
  }

  /** A `present_artifact` receipt's file, read through the Session workspace. */
  async #receiptArtifact(agentId: string, sessionKey: string, id: string) {
    const artifact = await this.#history.publishedArtifact(
      agentId,
      sessionKey,
      id
    )
    if (!artifact) throw new OpenClawWorkspaceOwnershipError()
    const file = parseOpenClawSessionFile(
      await readable(() =>
        this.#client.request(
          "sessions.files.get",
          openClawSessionFileParams(agentId, sessionKey, artifact.path)
        )
      )
    )
    const { filename, mimeType } = artifact.descriptor
    const nativeMime = artifactMime(file.mimeType)
    return {
      bytes: sessionFileBytes(file),
      ...(mimeType || nativeMime ? { mimeType: mimeType ?? nativeMime } : {}),
      filename,
    }
  }

  /** OpenClaw's own transcript artifact; the gateway scopes it to the Session. */
  async #nativeArtifact(agentId: string, sessionKey: string, id: string) {
    if (!isNativeArtifactId(id)) throw new OpenClawWorkspaceOwnershipError()
    const download = parseOpenClawArtifactDownload(
      await readable(() =>
        this.#client.request(
          "artifacts.download",
          openClawArtifactDownloadParams(agentId, sessionKey, id)
        )
      )
    )
    const mimeType = artifactMime(download.artifact.mimeType)
    return {
      bytes: await downloadBytes(download, this.#gatewayOrigin, this.#fetch),
      ...(mimeType ? { mimeType } : {}),
      filename: artifactFilename(download.artifact.title),
    }
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
        sessionTitle: operation,
        sessionArchival: operation,
        sessionPin: operation,
        sessionDeletion: operation,
        sessionTurn: operation,
        sessionStop: operation,
        sessionSteer: unavailable("native-active-turn-steering-unavailable"),
        sessionReadState: unavailable("native-session-read-state-unavailable"),
      },
    }
  }
}
