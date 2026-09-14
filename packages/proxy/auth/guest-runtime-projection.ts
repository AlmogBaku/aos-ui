import { createHash } from "node:crypto"

import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core"

import type { SessionHistoryResponse } from "../../protocol"
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
import type { SessionScope } from "../core/runtime"
import type { CoordinatorAccess } from "../core/session-coordinator"
import { validIdentifier } from "../routes/http"

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
  return projected
    ? new Response(JSON.stringify(projected), {
        status,
        headers: { "content-type": "application/json; charset=UTF-8" },
      })
    : new Response(null, { status })
}

export function projectGuestHistory(
  history: SessionHistoryResponse,
  authorization: GuestAuthorization
) {
  return {
    sessionId: history.sessionId,
    messages: history.messages.flatMap((message) => {
      if (message.role === "system" || message.role === "activity") return []
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
      return content.length === 0
        ? []
        : [
            {
              id: message.id,
              role: message.role,
              content,
              createdAt: message.createdAt,
            },
          ]
    }),
    total: history.total,
    limit: history.limit,
    offset: history.offset,
    nextOffset: history.nextOffset,
  }
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

function createRunProjector(
  scope: SessionScope,
  runId: string,
  read: VerifiedGuestAuthorization,
  errors: VerifiedGuestAuthorization,
  now: () => number
) {
  const assistantMessages = new Set<string>()
  return (candidate: AGUIEvent): AGUIEvent | undefined => {
    if (
      !guestAuthorizationActive(read, now) ||
      !guestAuthorizationActive(errors, now) ||
      !EventSchemas.safeParse(candidate).success
    )
      return undefined
    if (candidate.type === EventType.RUN_STARTED)
      return { type: EventType.RUN_STARTED, threadId: scope.threadId, runId }
    if (candidate.type === EventType.TEXT_MESSAGE_START) {
      if (
        candidate.role !== "assistant" ||
        !validIdentifier(candidate.messageId)
      )
        return undefined
      assistantMessages.add(candidate.messageId)
      return {
        type: EventType.TEXT_MESSAGE_START,
        messageId: guestMessageId(read.tokenId, candidate.messageId),
        role: "assistant",
      }
    }
    if (candidate.type === EventType.TEXT_MESSAGE_CONTENT) {
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
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: guestMessageId(read.tokenId, candidate.messageId),
            delta: projected.payload.text,
          }
        : undefined
    }
    if (candidate.type === EventType.TEXT_MESSAGE_END) {
      if (!assistantMessages.delete(candidate.messageId)) return undefined
      return {
        type: EventType.TEXT_MESSAGE_END,
        messageId: guestMessageId(read.tokenId, candidate.messageId),
      }
    }
    if (candidate.type === EventType.RUN_FINISHED) {
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
          type: EventType.RUN_FINISHED,
          threadId: scope.threadId,
          runId,
          outcome: {
            type: "interrupt",
            interrupts: [...projected.payload.interrupts],
          },
        }
      }
      return {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId,
        outcome: { type: "success" },
      }
    }
    if (candidate.type === EventType.RUN_ERROR) {
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
            type: EventType.RUN_ERROR,
            code: projected.payload.code,
            message:
              projected.payload.description ??
              guestErrorDescription(projected.payload.code),
          }
        : undefined
    }
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
