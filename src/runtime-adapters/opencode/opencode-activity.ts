import type { OpenCodeWorkspaceEvent } from "./opencode-event"

export type OpenCodeActivitySignal =
  | { kind: "run-active"; threadId: string }
  | { kind: "run-finished"; threadId: string }
  | { kind: "run-failed"; threadId: string }
  | { kind: "run-cancelled"; threadId: string }
  | {
      kind: "attention-requested"
      threadId: string
      attentionKind: "question" | "permission"
      requestId: string
    }
  | {
      kind: "attention-resolved"
      threadId: string
      requestId: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readProviderEventRecord(event: OpenCodeWorkspaceEvent) {
  if (!isRecord(event.raw)) return undefined
  return isRecord(event.raw.payload) ? event.raw.payload : event.raw
}

export function readOpenCodeEventId(event: OpenCodeWorkspaceEvent) {
  if (typeof event.id === "string" && event.id.length > 0) return event.id
  const providerEvent = readProviderEventRecord(event)
  return typeof providerEvent?.id === "string" && providerEvent.id.length > 0
    ? providerEvent.id
    : undefined
}

export function readOpenCodeEventOrder(
  event: OpenCodeWorkspaceEvent,
  threadId: string
) {
  const providerEvent = readProviderEventRecord(event)
  const durable = isRecord(event.durable)
    ? event.durable
    : isRecord(providerEvent?.durable)
      ? providerEvent.durable
      : undefined
  if (
    !durable ||
    typeof durable.seq !== "number" ||
    !Number.isSafeInteger(durable.seq) ||
    durable.seq < 0
  ) {
    return undefined
  }
  return {
    key:
      typeof durable.aggregateID === "string" && durable.aggregateID.length > 0
        ? durable.aggregateID
        : threadId,
    sequence: durable.seq,
  }
}

export function readOpenCodeEventOccurredAt(event: OpenCodeWorkspaceEvent) {
  const properties = isRecord(event.properties) ? event.properties : undefined
  const timestamp =
    typeof properties?.timestamp === "number"
      ? properties.timestamp
      : typeof properties?.time === "number"
        ? properties.time
        : Date.now()
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString()
}

function readEventThreadId(event: OpenCodeWorkspaceEvent) {
  if (isRecord(event.properties)) {
    if (typeof event.properties.sessionID === "string") {
      return event.properties.sessionID
    }
    if (isRecord(event.properties.info)) {
      const { id, sessionID } = event.properties.info
      if (typeof sessionID === "string") return sessionID
      if (typeof id === "string") return id
    }
  }
  return typeof event.sessionId === "string" ? event.sessionId : undefined
}

export function readOpenCodeEventAgentId(event: OpenCodeWorkspaceEvent) {
  if (typeof event.agentId === "string") return event.agentId
  if (!isRecord(event.properties) || !isRecord(event.properties.info)) {
    return undefined
  }
  return typeof event.properties.info.agent === "string"
    ? event.properties.info.agent
    : undefined
}

export function readOpenCodeActivitySignal(
  event: OpenCodeWorkspaceEvent
): OpenCodeActivitySignal | undefined {
  const threadId = readEventThreadId(event)
  if (!threadId || !isRecord(event.properties)) return undefined

  if (event.type === "session.status") {
    const status = isRecord(event.properties.status)
      ? event.properties.status.type
      : undefined
    if (status === "busy" || status === "retry") {
      return { kind: "run-active", threadId }
    }
    if (status === "idle") return { kind: "run-finished", threadId }
    return undefined
  }
  if (event.type === "session.idle") {
    return { kind: "run-finished", threadId }
  }
  if (event.type === "session.error") {
    const error = isRecord(event.properties.error)
      ? event.properties.error
      : undefined
    if (!error || typeof error.name !== "string" || error.name.length === 0) {
      return undefined
    }
    return error.name === "MessageAbortedError"
      ? { kind: "run-cancelled", threadId }
      : { kind: "run-failed", threadId }
  }

  const questionAsked =
    event.type === "question.asked" || event.type === "question.v2.asked"
  const permissionAsked =
    event.type === "permission.asked" || event.type === "permission.v2.asked"
  if (questionAsked || permissionAsked) {
    const requestId = event.properties.id
    if (typeof requestId !== "string" || requestId.length === 0) {
      return undefined
    }
    return {
      kind: "attention-requested",
      threadId,
      attentionKind: questionAsked ? "question" : "permission",
      requestId,
    }
  }

  const questionResolved =
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "question.v2.replied" ||
    event.type === "question.v2.rejected"
  const permissionResolved =
    event.type === "permission.replied" ||
    event.type === "permission.rejected" ||
    event.type === "permission.v2.replied" ||
    event.type === "permission.v2.rejected"
  if (questionResolved || permissionResolved) {
    const requestId =
      typeof event.properties.requestID === "string"
        ? event.properties.requestID
        : event.properties.permissionID
    if (typeof requestId !== "string" || requestId.length === 0) {
      return undefined
    }
    return { kind: "attention-resolved", threadId, requestId }
  }

  return undefined
}

export function openCodeActivityIdPart(value: string) {
  return encodeURIComponent(value)
}
