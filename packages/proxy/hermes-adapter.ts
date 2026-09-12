import {
  AgentCatalogResponseSchema,
  HermesAuthStateSchema,
  RuntimeInfoSchema,
  VisibilityUpdateResponseSchema,
  type AgentCatalogEntry,
  type AgentCatalogResponse,
  type HermesAuthState,
  type RuntimeInfo,
  type VisibilityUpdateResponse,
} from "../protocol"

export interface HermesRpcTransport {
  request(
    method: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown>
  authState?(): Promise<HermesAuthState>
  close?(): Promise<void>
}

export class HermesRevisionConflictError extends Error {
  constructor() {
    super("Agent visibility revision conflict")
    this.name = "HermesRevisionConflictError"
  }
}

export class HermesUnavailableError extends Error {
  constructor() {
    super("Hermes is temporarily unavailable")
    this.name = "HermesUnavailableError"
  }
}

type NativeRecord = Record<string, unknown>

function isRecord(value: unknown): value is NativeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function nativeRevision(profile: NativeRecord) {
  const revisions = isRecord(profile.ui_meta_revisions)
    ? profile.ui_meta_revisions
    : undefined
  const revision = revisions?.["hermes-bots"]
  return typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 0
    ? revision
    : undefined
}

function nativeBots(profile: NativeRecord) {
  const uiMeta = isRecord(profile.ui_meta) ? profile.ui_meta : {}
  return isRecord(uiMeta["hermes-bots"]) ? uiMeta["hermes-bots"] : {}
}

function projectProfile(profile: NativeRecord): AgentCatalogEntry {
  const id = nonEmptyString(profile.name)
  if (!id) throw new HermesUnavailableError()
  const uiMeta = isRecord(profile.ui_meta) ? profile.ui_meta : {}
  const aos = isRecord(uiMeta.aos) ? uiMeta.aos : {}
  const bots = nativeBots(profile)
  const revision = nativeRevision(profile)
  const visibility =
    bots.hidden === true ? ("hidden" as const) : ("visible" as const)
  const creator = aos.role === "creator"
  return {
    summary: {
      kind: "ready",
      id,
      name: nonEmptyString(profile.display_name) ?? id,
      ...(nonEmptyString(profile.description)
        ? { description: nonEmptyString(profile.description) }
        : {}),
      activity: "unknown",
      visibility,
      ...(creator ? { role: "creator" as const } : {}),
    },
    visibility,
    selectable: visibility === "visible" && !creator,
    editable: revision !== undefined && !creator,
    revision:
      revision === undefined ? "unavailable" : `hermes-bots:${revision}`,
  }
}

function nativeProfiles(payload: unknown): NativeRecord[] {
  if (!isRecord(payload) || !Array.isArray(payload.profiles))
    throw new HermesUnavailableError()
  const profiles = payload.profiles
  if (!profiles.every(isRecord)) throw new HermesUnavailableError()
  return profiles
}

function catalogRevision(agents: readonly AgentCatalogEntry[]) {
  return `profiles:${agents
    .map(({ summary, revision }) => `${summary.id}@${revision}`)
    .sort()
    .join(",")}`
}

export class HermesServerAdapter {
  constructor(private readonly transport: HermesRpcTransport) {}

  async authState(): Promise<HermesAuthState> {
    if (this.transport.authState)
      return HermesAuthStateSchema.parse(await this.transport.authState())
    try {
      await this.transport.request("profiles.list", { include_sessions: false })
      return { status: "authenticated", method: "static-token" }
    } catch {
      return { status: "unavailable", reason: "temporarily-unavailable" }
    }
  }

  async listAgents(): Promise<AgentCatalogResponse> {
    let payload: unknown
    try {
      payload = await this.transport.request("profiles.list", {
        include_sessions: false,
      })
      const agents = nativeProfiles(payload).map(projectProfile)
      if (
        new Set(agents.map(({ summary }) => summary.id)).size !== agents.length
      )
        throw new HermesUnavailableError()
      return AgentCatalogResponseSchema.parse({
        revision: catalogRevision(agents),
        agents,
      })
    } catch (error) {
      if (error instanceof HermesUnavailableError) throw error
      throw new HermesUnavailableError()
    }
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    let visibilityAvailable = false
    try {
      const catalog = await this.listAgents()
      visibilityAvailable = catalog.agents.every(
        ({ summary, revision }) =>
          summary.role === "creator" || revision !== "unavailable"
      )
    } catch {
      return RuntimeInfoSchema.parse({
        runtime: { id: "hermes", name: "Hermes" },
        status: "unavailable",
        capabilities: {
          agentCatalog: {
            status: "unavailable",
            reason: "temporarily-unavailable",
          },
          agentVisibility: {
            status: "unavailable",
            reason: "temporarily-unavailable",
          },
          sessionCreation: { status: "unavailable", reason: "not-implemented" },
        },
      })
    }
    return RuntimeInfoSchema.parse({
      runtime: { id: "hermes", name: "Hermes" },
      status: "ready",
      capabilities: {
        agentCatalog: { status: "available" },
        agentVisibility: visibilityAvailable
          ? { status: "available", concurrency: "revision" }
          : { status: "unavailable", reason: "native-revision-unavailable" },
        sessionCreation: { status: "unavailable", reason: "not-implemented" },
      },
    })
  }

  async updateAgentVisibility(
    agentId: string,
    visibility: "visible" | "hidden",
    observedRevision: string
  ): Promise<VisibilityUpdateResponse> {
    const before = await this.listAgents()
    const current = before.agents.find(({ summary }) => summary.id === agentId)
    if (!current) throw new HermesUnavailableError()
    if (!current.editable || current.revision === "unavailable")
      throw new HermesUnavailableError()
    if (current.revision !== observedRevision)
      throw new HermesRevisionConflictError()
    const expected = Number(current.revision.slice("hermes-bots:".length))

    let described: unknown
    try {
      described = await this.transport.request("profiles.describe", {
        name: agentId,
      })
    } catch {
      throw new HermesUnavailableError()
    }
    if (!isRecord(described) || nonEmptyString(described.name) !== agentId)
      throw new HermesUnavailableError()
    if (nativeRevision(described) !== expected)
      throw new HermesRevisionConflictError()

    let configured: unknown
    try {
      configured = await this.transport.request("profiles.configure", {
        name: agentId,
        ui_meta: {
          "hermes-bots": {
            ...nativeBots(described),
            hidden: visibility === "hidden",
          },
        },
        ui_meta_expected_revisions: { "hermes-bots": expected },
      })
    } catch {
      throw new HermesUnavailableError()
    }
    const applied =
      isRecord(configured) && isRecord(configured.applied)
        ? configured.applied
        : undefined
    if (applied?.ui_meta !== true) {
      if (applied && isRecord(applied.ui_meta_conflicts))
        throw new HermesRevisionConflictError()
      throw new HermesUnavailableError()
    }

    const confirmed = await this.listAgents()
    const agent = confirmed.agents.find(({ summary }) => summary.id === agentId)
    if (!agent || agent.visibility !== visibility)
      throw new HermesUnavailableError()
    return VisibilityUpdateResponseSchema.parse({
      revision: confirmed.revision,
      agent,
    })
  }

  async close() {
    await this.transport.close?.()
  }
}
