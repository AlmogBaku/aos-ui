import { createHash } from "node:crypto"

import {
  GuestRuntimeCapabilitiesResponseSchema,
  SessionHistoryResponseSchema,
  SessionPlanActivityMessageSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  type SessionHistoryResponse,
} from "../../protocol"
import type {
  GuestAuthorization,
  VerifiedGuestAuthorization,
} from "./guest-invitation"
import {
  guestErrorDescription,
  projectGuestOutbound,
  type GuestPublicErrorCode,
} from "./guest-projection"
import { guestAuthorizationActive, guestControllerId } from "./guest-request"
import {
  isRunEvent,
  RunEventKind,
  type RunEvent,
  type RunEventOf,
} from "../core/events"
import type { SessionScope } from "../core/runtime"
import type { CoordinatorAccess } from "../core/session-coordinator"
import { validIdentifier } from "../routes/http"

function isPrivateFirstTurn(content: unknown, instruction: string) {
  if (!Array.isArray(content) || content.length !== 1) return false
  const part = content[0]
  if (part?.type !== "text") return false
  try {
    const value = JSON.parse(part.text) as unknown
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).v === 1 &&
      (value as Record<string, unknown>).type === "aos.guest.first-turn" &&
      (value as Record<string, unknown>).instruction === instruction
    )
  } catch {
    return false
  }
}

export function projectGuestError(
  authorization: GuestAuthorization,
  code: GuestPublicErrorCode,
  retryable: boolean,
  status: number
) {
  const projected = projectGuestOutbound(
    {
      transport: "error",
      agentId: authorization.agentId,
      sessionId: authorization.sessionId,
      payload: {
        type: "error",
        code,
        description: guestErrorDescription(code),
        retryable,
      },
    },
    authorization
  )
  return projected?.payload.type === "error"
    ? new Response(
        JSON.stringify({
          error: {
            code:
              projected.payload.code === "rate_limited"
                ? "run_capacity_exceeded"
                : projected.payload.code === "request_failed"
                  ? "run_conflict"
                  : projected.payload.code,
            description:
              projected.payload.description ??
              guestErrorDescription(projected.payload.code),
          },
        }),
        {
          status,
          headers: { "content-type": "application/json; charset=UTF-8" },
        }
      )
    : new Response(null, { status })
}

export function projectGuestHistory(
  history: SessionHistoryResponse,
  authorization: GuestAuthorization,
  publicSessionId = history.sessionId
) {
  const messages: unknown[] = []
  for (const [index, message] of history.messages.entries()) {
    if (message.role === "system") continue
    if (
      index === 0 &&
      history.offset === 0 &&
      message.role === "user" &&
      authorization.firstTurn?.instruction &&
      isPrivateFirstTurn(message.content, authorization.firstTurn.instruction)
    )
      continue
    if (message.role === "activity") {
      messages.push(message)
      continue
    }
    const content = message.content.flatMap((part) => {
      if (part.type !== "text") return []
      const projected = projectGuestOutbound(
        {
          transport: "rest",
          agentId: authorization.agentId,
          sessionId: authorization.sessionId,
          payload: {
            type: "message",
            role: message.role === "user" ? "guest" : "assistant",
            text: part.text,
          },
        },
        authorization
      )
      return projected?.payload.type === "message" &&
        projected.payload.text !== undefined
        ? [{ type: "text" as const, text: projected.payload.text }]
        : []
    })
    const interrupts =
      message.role === "assistant" &&
      message.metadata?.custom.agui &&
      typeof message.metadata.custom.agui === "object" &&
      message.metadata.custom.agui !== null &&
      !Array.isArray(message.metadata.custom.agui)
        ? (message.metadata.custom.agui as { interrupts?: unknown }).interrupts
        : undefined
    const projectedInterrupts = Array.isArray(interrupts)
      ? projectGuestOutbound(
          {
            transport: "rest",
            agentId: authorization.agentId,
            sessionId: authorization.sessionId,
            payload: { type: "interrupt", interrupts },
          },
          authorization
        )
      : undefined
    if (
      content.length === 0 &&
      projectedInterrupts?.payload.type !== "interrupt" &&
      !message.attachments?.length
    )
      continue
    messages.push({
      id: message.id,
      role: message.role,
      content,
      createdAt: message.createdAt,
      ...(message.role === "user" && message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      ...(projectedInterrupts?.payload.type === "interrupt"
        ? {
            status: {
              type: "requires-action" as const,
              reason: "interrupt" as const,
            },
            metadata: {
              custom: {
                agui: {
                  interrupts: projectedInterrupts.payload.interrupts.map(
                    (interrupt) => ({ ...interrupt })
                  ),
                },
              },
            },
          }
        : {}),
    })
  }
  return SessionHistoryResponseSchema.parse({
    sessionId: publicSessionId,
    messages,
    total: history.total,
    limit: history.limit,
    offset: history.offset,
    nextOffset: history.nextOffset,
    ...(history.execution === undefined
      ? {}
      : {
          execution: {
            status: history.execution.status,
            ...(history.execution.runId === undefined
              ? {}
              : { runId: history.execution.runId }),
          },
        }),
  })
}

export function projectGuestCapabilities(value: unknown) {
  const parsed = SessionWorkspaceCapabilitiesResponseSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { content, interactions, workspace } = parsed.data
  return GuestRuntimeCapabilitiesResponseSchema.parse({
    workspace: { slashCommands: workspace.slashCommands },
    content,
    interactions: {
      ...interactions,
      steering: {
        status: "unavailable",
        reason: "operator-run-control-required",
      },
      approvals: {
        ...interactions.approvals,
        choices: interactions.approvals.choices.filter(
          ({ value }) => value !== "always"
        ),
      },
    },
  })
}

function publicRunError(code: string | undefined) {
  if (code === "AOS_CONNECTION_INTERRUPTED")
    return { code, retryable: true } as const
  if (code === "AOS_SEND_UNCERTAIN") return { code, retryable: true } as const
  if (code === "AOS_INTERACTION_UNCERTAIN")
    return { code, retryable: true } as const
  if (code === "AOS_RESET_REQUIRED")
    return { code: "temporarily_unavailable", retryable: true } as const
  return { code: "request_failed", retryable: false } as const
}

function guestMessageId(tokenId: string, sourceId: string) {
  return `guest-message-${createHash("sha256")
    .update(tokenId)
    .update("\0")
    .update(sourceId)
    .digest("base64url")
    .slice(0, 24)}`
}

function projectPlanSnapshot(
  candidate: RunEventOf<typeof RunEventKind.ACTIVITY_SNAPSHOT>
): RunEventOf<typeof RunEventKind.ACTIVITY_SNAPSHOT> | undefined {
  const parsed = SessionPlanActivityMessageSchema.safeParse({
    id: candidate.messageId,
    role: "activity",
    activityType: candidate.activityType,
    content: candidate.content,
  })
  return parsed.success
    ? {
        type: RunEventKind.ACTIVITY_SNAPSHOT,
        messageId: parsed.data.id,
        activityType: "PLAN" as const,
        content: parsed.data.content,
        replace: candidate.replace,
      }
    : undefined
}

function projectPlanDelta(
  candidate: RunEventOf<typeof RunEventKind.ACTIVITY_DELTA>
): RunEventOf<typeof RunEventKind.ACTIVITY_DELTA> | undefined {
  const patch = candidate.patch
  if (
    candidate.activityType !== "PLAN" ||
    patch.length !== 1 ||
    typeof patch[0] !== "object" ||
    patch[0] === null ||
    Array.isArray(patch[0])
  )
    return undefined
  const operation = patch[0] as Record<string, unknown>
  if (
    operation.op !== "replace" ||
    operation.path !== "/todos" ||
    Object.keys(operation).some(
      (key) => key !== "op" && key !== "path" && key !== "value"
    )
  )
    return undefined
  const parsed = SessionPlanActivityMessageSchema.safeParse({
    id: candidate.messageId,
    role: "activity",
    activityType: "PLAN",
    content: { todos: operation.value },
  })
  return parsed.success
    ? {
        type: RunEventKind.ACTIVITY_DELTA,
        messageId: parsed.data.id,
        activityType: "PLAN" as const,
        patch: [
          {
            op: "replace",
            path: "/todos",
            value: parsed.data.content.todos,
          },
        ],
      }
    : undefined
}

function projectArtifact(
  candidate: RunEventOf<typeof RunEventKind.CUSTOM>
): RunEventOf<typeof RunEventKind.CUSTOM> | undefined {
  if (
    candidate.name !== "aos.artifact" ||
    typeof candidate.value !== "object" ||
    candidate.value === null ||
    Array.isArray(candidate.value)
  )
    return undefined
  const value = candidate.value as Record<string, unknown>
  const source = value.source
  if (
    typeof value.id !== "string" ||
    !validIdentifier(value.id) ||
    typeof value.filename !== "string" ||
    value.filename.length === 0 ||
    value.filename.length > 4_096 ||
    (value.mimeType !== undefined &&
      (typeof value.mimeType !== "string" || value.mimeType.length > 256)) ||
    (value.sizeBytes !== undefined &&
      (!Number.isSafeInteger(value.sizeBytes) ||
        (value.sizeBytes as number) < 0)) ||
    typeof source !== "object" ||
    source === null ||
    Array.isArray(source) ||
    (source as Record<string, unknown>).type !== "provider" ||
    (source as Record<string, unknown>).reference !== value.id
  )
    return undefined
  const id = value.id
  return {
    type: RunEventKind.CUSTOM,
    name: "aos.artifact",
    value: {
      id,
      filename: value.filename,
      ...(value.mimeType === undefined ? {} : { mimeType: value.mimeType }),
      ...(value.sizeBytes === undefined ? {} : { sizeBytes: value.sizeBytes }),
      source: { type: "provider", reference: id },
    },
  } as const
}

function createRunProjector(
  scope: SessionScope,
  runId: string,
  read: VerifiedGuestAuthorization,
  errors: VerifiedGuestAuthorization,
  now: () => number
) {
  const assistantMessages = new Set<string>()
  return (candidate: RunEvent): RunEvent | undefined => {
    if (
      !guestAuthorizationActive(read, now) ||
      !guestAuthorizationActive(errors, now) ||
      !isRunEvent(candidate)
    )
      return undefined
    if (candidate.type === RunEventKind.RUN_STARTED)
      return { type: RunEventKind.RUN_STARTED, threadId: scope.threadId, runId }
    if (candidate.type === RunEventKind.TEXT_MESSAGE_START) {
      if (
        candidate.role !== "assistant" ||
        !validIdentifier(candidate.messageId)
      )
        return undefined
      assistantMessages.add(candidate.messageId)
      return {
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: guestMessageId(read.tokenId, candidate.messageId),
        role: "assistant",
      }
    }
    if (candidate.type === RunEventKind.TEXT_MESSAGE_CONTENT) {
      if (!assistantMessages.has(candidate.messageId)) return undefined
      const projected = projectGuestOutbound(
        {
          transport: "ag-ui",
          agentId: scope.agentId,
          sessionId: scope.threadId,
          payload: {
            type: "message",
            role: "assistant",
            text: candidate.delta,
          },
        },
        read
      )
      return projected?.payload.type === "message" &&
        projected.payload.text !== undefined
        ? {
            type: RunEventKind.TEXT_MESSAGE_CONTENT,
            messageId: guestMessageId(read.tokenId, candidate.messageId),
            delta: projected.payload.text,
          }
        : undefined
    }
    if (candidate.type === RunEventKind.TEXT_MESSAGE_END) {
      if (!assistantMessages.delete(candidate.messageId)) return undefined
      return {
        type: RunEventKind.TEXT_MESSAGE_END,
        messageId: guestMessageId(read.tokenId, candidate.messageId),
      }
    }
    if (candidate.type === RunEventKind.RUN_FINISHED) {
      if (candidate.outcome?.type === "interrupt") {
        const projected = projectGuestOutbound(
          {
            transport: "ag-ui",
            agentId: scope.agentId,
            sessionId: scope.threadId,
            payload: {
              type: "interrupt",
              interrupts: candidate.outcome.interrupts,
            },
          },
          read
        )
        if (projected?.payload.type !== "interrupt") return undefined
        return {
          type: RunEventKind.RUN_FINISHED,
          threadId: scope.threadId,
          runId,
          outcome: {
            type: "interrupt",
            interrupts: [...projected.payload.interrupts],
          },
        }
      }
      return {
        type: RunEventKind.RUN_FINISHED,
        threadId: scope.threadId,
        runId,
        outcome: { type: "success" },
      }
    }
    if (candidate.type === RunEventKind.RUN_ERROR) {
      const error = publicRunError(candidate.code)
      const projected = projectGuestOutbound(
        {
          transport: "error",
          agentId: scope.agentId,
          sessionId: scope.threadId,
          payload: {
            type: "error",
            code: error.code,
            description: guestErrorDescription(error.code),
            retryable: error.retryable,
          },
        },
        errors
      )
      return projected?.payload.type === "error"
        ? {
            type: RunEventKind.RUN_ERROR,
            code: projected.payload.code,
            message:
              projected.payload.description ??
              guestErrorDescription(projected.payload.code),
          }
        : undefined
    }
    if (candidate.type === RunEventKind.ACTIVITY_SNAPSHOT)
      return projectPlanSnapshot(candidate)
    if (candidate.type === RunEventKind.ACTIVITY_DELTA)
      return projectPlanDelta(candidate)
    if (candidate.type === RunEventKind.CUSTOM)
      return projectArtifact(candidate)
    return undefined
  }
}

export function createGuestRunAccess(
  read: VerifiedGuestAuthorization,
  errors: VerifiedGuestAuthorization,
  scope: SessionScope,
  runId: string,
  now: () => number,
  subscriberId: string
): CoordinatorAccess {
  return {
    subscriberId,
    controllerId: guestControllerId(read),
    lane: "guest",
    canControl: true,
    project: createRunProjector(scope, runId, read, errors, now),
  }
}
