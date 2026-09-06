import type { AgentDraftCandidate } from "./agent-draft"

export type OpenCodeWorkspaceEvent = {
  id?: unknown
  type?: unknown
  sessionId?: unknown
  agentId?: unknown
  durable?: unknown
  properties?: unknown
  raw?: unknown
}

const AGENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
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

function readBoundedLine(value: unknown, maximum: number) {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\r\n\u2028\u2029\0]/u.test(normalized)
  ) {
    return undefined
  }
  return normalized
}

function readCreatedAgentPart(
  part: unknown,
  expectedThreadId: string
): AgentDraftCandidate | undefined {
  if (
    !isRecord(part) ||
    part.type !== "tool" ||
    part.tool !== "create_agent" ||
    part.sessionID !== expectedThreadId ||
    typeof part.callID !== "string" ||
    part.callID.length === 0 ||
    part.callID.length > 160 ||
    !isRecord(part.state) ||
    part.state.status !== "completed" ||
    !isRecord(part.state.metadata) ||
    !isRecord(part.state.metadata.aos_ui)
  ) {
    return undefined
  }

  const result = part.state.metadata.aos_ui
  const agentId = readBoundedLine(result.agentId, 48)
  const name = readBoundedLine(result.name, 80)
  const description = readBoundedLine(result.description, 280)
  if (
    result.version !== 1 ||
    result.kind !== "agent-created" ||
    result.draftThreadId !== expectedThreadId ||
    !agentId ||
    !AGENT_ID.test(agentId) ||
    RESERVED_AGENT_IDS.has(agentId) ||
    !name ||
    !description
  ) {
    return undefined
  }

  return { agentId, name, description, callId: part.callID }
}

export function readAgentCreatedEvent(event: OpenCodeWorkspaceEvent) {
  if (event.type !== "message.part.updated" || !isRecord(event.properties)) {
    return undefined
  }
  const { part } = event.properties
  const sessionID =
    typeof event.properties.sessionID === "string"
      ? event.properties.sessionID
      : typeof event.sessionId === "string"
        ? event.sessionId
        : undefined
  if (!sessionID) return undefined

  const candidate = readCreatedAgentPart(part, sessionID)
  return candidate ? { threadId: sessionID, candidate } : undefined
}

/**
 * Recovery is intentionally limited to the same completed tool-state receipt
 * accepted from the live event stream. Assistant prose and tool output text
 * are never interpreted as lifecycle state.
 */
export function readAgentCreatedFromMessages(
  messages: unknown,
  expectedThreadId: string
) {
  if (!Array.isArray(messages)) return undefined
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex]
    if (!isRecord(message) || !Array.isArray(message.parts)) continue
    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const candidate = readCreatedAgentPart(
        message.parts[partIndex],
        expectedThreadId
      )
      if (candidate) return candidate
    }
  }
  return undefined
}
