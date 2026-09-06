import type {
  AgentBuilderCreationOptions,
  AgentIcon,
  ProvisionalAgentPhase,
  ProvisionalAgentSummary,
} from "../contracts"

export const AGENT_BUILDER_ID = "agent-builder"
export const AGENT_BUILDER_KICKOFF = "Hey, let's build a new agent."
export const AGENT_DRAFT_TITLE = "New Agent"
export const AGENT_DRAFT_DESCRIPTION = "Being designed with Agent Builder"
export const AGENT_FIRST_SESSION_TITLE = "New session"

export type AgentDraftCandidate = {
  agentId: string
  name: string
  description: string
  callId: string
}

export type AgentDraftMetadata = {
  version: 1
  kind: "agent-draft"
  phase: ProvisionalAgentPhase | "promoted" | "deleted"
  revision: number
  labels?: AgentBuilderCreationOptions
  candidate?: AgentDraftCandidate
  firstSessionId?: string
  promotedAgentId?: string
  lastError?: string
}

const iconTones = ["indigo", "purple", "teal", "ochre", "slate"] as const
const AGENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const AGENT_DRAFT_PHASES = new Set([
  "interview",
  "start-failed",
  "activating",
  "activation-failed",
  "promoted",
  "deleted",
])
const RESERVED_AGENT_IDS = new Set([
  "agent-builder",
  "build",
  "plan",
  "general",
  "explore",
  "en",
  "he",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalBoundedString(value: unknown, maximum = 280) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : undefined
}

function readCandidate(value: unknown): AgentDraftCandidate | undefined {
  if (!isRecord(value)) return undefined
  const agentId = optionalBoundedString(value.agentId, 48)
  const name = optionalBoundedString(value.name, 80)
  const description = optionalBoundedString(value.description, 280)
  const callId = optionalBoundedString(value.callId, 160)
  if (
    !agentId ||
    !AGENT_ID.test(agentId) ||
    RESERVED_AGENT_IDS.has(agentId) ||
    !name ||
    !description ||
    !callId
  ) {
    return undefined
  }
  return { agentId, name, description, callId }
}

function readLabels(value: unknown): AgentBuilderCreationOptions | undefined {
  if (!isRecord(value)) return undefined
  const draftTitle = optionalBoundedString(value.draftTitle, 80)
  const draftDescription = optionalBoundedString(value.draftDescription, 280)
  const firstSessionTitle = optionalBoundedString(value.firstSessionTitle, 80)
  if (!draftTitle || !draftDescription || !firstSessionTitle) return undefined
  return { draftTitle, draftDescription, firstSessionTitle }
}

export function createAgentDraftMetadata(
  labels?: AgentBuilderCreationOptions
): AgentDraftMetadata {
  return {
    version: 1,
    kind: "agent-draft",
    phase: "interview",
    revision: 1,
    ...(labels ? { labels } : {}),
  }
}

export function readAgentDraftMetadata(
  metadata: unknown
): AgentDraftMetadata | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.aos_ui)) return undefined
  const value = metadata.aos_ui
  if (
    value.version !== 1 ||
    value.kind !== "agent-draft" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  ) {
    return undefined
  }
  if (typeof value.phase !== "string" || !AGENT_DRAFT_PHASES.has(value.phase)) {
    return undefined
  }

  const candidate =
    value.candidate === undefined ? undefined : readCandidate(value.candidate)
  if (value.candidate !== undefined && !candidate) return undefined
  const labels =
    value.labels === undefined ? undefined : readLabels(value.labels)
  if (value.labels !== undefined && !labels) return undefined
  const firstSessionId = optionalBoundedString(value.firstSessionId, 160)
  const promotedAgentId = optionalBoundedString(value.promotedAgentId, 48)
  const lastError = optionalBoundedString(value.lastError, 500)

  return {
    version: 1,
    kind: "agent-draft",
    phase: value.phase as AgentDraftMetadata["phase"],
    revision: Number(value.revision),
    ...(labels ? { labels } : {}),
    ...(candidate ? { candidate } : {}),
    ...(firstSessionId ? { firstSessionId } : {}),
    ...(promotedAgentId ? { promotedAgentId } : {}),
    ...(lastError ? { lastError } : {}),
  }
}

export function explainInvalidAgentDraftMetadata(metadata: unknown) {
  if (readAgentDraftMetadata(metadata)) return undefined
  if (!isRecord(metadata) || !("aos_ui" in metadata)) {
    return "missing AOS metadata"
  }
  if (!isRecord(metadata.aos_ui)) return "invalid AOS metadata"
  if (metadata.aos_ui.version !== 1) {
    return "unsupported AOS metadata version"
  }
  if (metadata.aos_ui.kind !== "agent-draft") {
    return "unsupported AOS metadata kind"
  }
  if (
    typeof metadata.aos_ui.phase !== "string" ||
    !AGENT_DRAFT_PHASES.has(metadata.aos_ui.phase)
  ) {
    return "unsupported Agent draft phase"
  }
  return "invalid AOS Agent draft metadata"
}

export function draftAgentId(threadId: string) {
  return `draft:${threadId}`
}

export function readDraftThreadId(agentId: string) {
  if (!agentId.startsWith("draft:")) return undefined
  const threadId = agentId.slice("draft:".length)
  return threadId.length > 0 ? threadId : undefined
}

export function draftIcon(threadId: string): AgentIcon {
  let hash = 2166136261
  for (const character of threadId) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return {
    kind: "symbol",
    symbol: "unassigned",
    tone: iconTones[Math.abs(hash) % iconTones.length]!,
  }
}

export function projectAgentDraft(
  threadId: string,
  metadata: AgentDraftMetadata
): ProvisionalAgentSummary | undefined {
  if (metadata.phase === "promoted" || metadata.phase === "deleted") {
    return undefined
  }
  return {
    kind: "provisional",
    id: draftAgentId(threadId),
    name:
      metadata.candidate?.name ??
      metadata.labels?.draftTitle ??
      AGENT_DRAFT_TITLE,
    description:
      metadata.candidate?.description ??
      metadata.labels?.draftDescription ??
      AGENT_DRAFT_DESCRIPTION,
    status:
      metadata.phase === "activating"
        ? "running"
        : metadata.phase.endsWith("failed")
          ? "attention"
          : "idle",
    icon: draftIcon(threadId),
    builderThreadId: threadId,
    phase: metadata.phase,
    ...(metadata.lastError ? { lastError: metadata.lastError } : {}),
  }
}

export function nextAgentDraftMetadata(
  current: AgentDraftMetadata,
  patch: Partial<Omit<AgentDraftMetadata, "version" | "kind" | "revision">>
): AgentDraftMetadata {
  return { ...current, ...patch, revision: current.revision + 1 }
}
