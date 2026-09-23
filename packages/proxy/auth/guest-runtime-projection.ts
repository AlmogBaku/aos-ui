import { createHash } from "node:crypto"

import {
  GuestRuntimeCapabilitiesResponseSchema,
  SessionHistoryResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  type SessionHistoryResponse,
  type SessionMessage,
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
  isTurnEvent,
  TurnEventKind,
  type TurnEvent,
  type TurnEventOf,
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
                ? "turn_capacity_exceeded"
                : projected.payload.code === "request_failed"
                  ? "turn_conflict"
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

/** The normalized turn failure code a restored failed turn carries, if any. */
function restoredTurnErrorCode(metadata: SessionMessage["metadata"]) {
  const aos = metadata?.custom.aos
  if (typeof aos !== "object" || aos === null || Array.isArray(aos))
    return undefined
  const code = (aos as Record<string, unknown>).turnErrorCode
  return typeof code === "string" ? code : undefined
}

/**
 * One message's text as the guest may read it. A user turn projects under the
 * `guest` role whoever sent it; `undefined` means the guest sees none of it.
 */
export function projectGuestText(
  authorization: GuestAuthorization,
  role: "guest" | "assistant",
  text: string
) {
  const projected = projectGuestOutbound(
    {
      transport: "rest",
      agentId: authorization.agentId,
      sessionId: authorization.sessionId,
      payload: { type: "message", role, text },
    },
    authorization
  )
  return projected?.payload.type === "message"
    ? projected.payload.text
    : undefined
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
    const content = message.content.flatMap(
      (part): SessionMessage["content"] => {
        // An MCP App reaches a guest as its card alone: its input and result
        // travel only through the invitation's own view route.
        if (part.type === "tool-call")
          return part.app
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: {},
                  argsText: "",
                  ...(part.isError ? { isError: true } : {}),
                  app: true as const,
                },
              ]
            : []
        if (part.type !== "text") return []
        const text = projectGuestText(
          authorization,
          message.role === "user" ? "guest" : "assistant",
          part.text
        )
        return text === undefined ? [] : [{ type: "text" as const, text }]
      }
    )
    // A turn the provider failed reaches a guest as a failed turn, never as an
    // ordinary reply: its public text is projected like any other, and its
    // status carries the guest catalogue's description of the mapped failure.
    const failure =
      message.role === "assistant" && message.status?.type === "incomplete"
        ? publicTurnError(restoredTurnErrorCode(message.metadata))
        : undefined
    if (
      content.length === 0 &&
      failure === undefined &&
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
      ...(failure
        ? {
            status: {
              type: "incomplete" as const,
              reason: "error" as const,
              error: guestErrorDescription(failure.code),
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
            ...(history.execution.turnId === undefined
              ? {}
              : { turnId: history.execution.turnId }),
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
        reason: "operator-turn-control-required",
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

/**
 * Guest-visible turn failures. Only a code a guest client can act on keeps its
 * identity; every other normalized failure collapses into a generic one.
 */
const guestTurnErrors: Readonly<
  Record<string, { code: GuestPublicErrorCode; retryable: boolean }>
> = {
  AOS_CONNECTION_INTERRUPTED: {
    code: "AOS_CONNECTION_INTERRUPTED",
    retryable: true,
  },
  AOS_SEND_UNCERTAIN: { code: "AOS_SEND_UNCERTAIN", retryable: true },
  AOS_INTERACTION_UNCERTAIN: {
    code: "AOS_INTERACTION_UNCERTAIN",
    retryable: true,
  },
  AOS_STOP_UNCERTAIN: { code: "AOS_STOP_UNCERTAIN", retryable: true },
  AOS_RESET_REQUIRED: { code: "temporarily_unavailable", retryable: true },
  AOS_STREAM_OVERFLOW: { code: "temporarily_unavailable", retryable: true },
  AOS_PROVIDER_RETRYABLE_FAILURE: {
    code: "temporarily_unavailable",
    retryable: true,
  },
  AOS_PROVIDER_AGENT_UNAVAILABLE: {
    code: "temporarily_unavailable",
    retryable: true,
  },
  AOS_PROVIDER_UNAVAILABLE: {
    code: "temporarily_unavailable",
    retryable: true,
  },
  AOS_SESSION_BUSY: { code: "rate_limited", retryable: true },
  AOS_SESSION_LIMIT: { code: "rate_limited", retryable: true },
}

function publicTurnError(code: string | undefined) {
  // Only an own entry names a guest-visible failure: an inherited object key
  // must collapse into the generic one like any unknown code.
  return (
    (code !== undefined && Object.hasOwn(guestTurnErrors, code)
      ? guestTurnErrors[code]
      : undefined) ?? {
      code: "request_failed" as const,
      retryable: false,
    }
  )
}

function guestMessageId(tokenId: string, sourceId: string) {
  return `guest-message-${createHash("sha256")
    .update(tokenId)
    .update("\0")
    .update(sourceId)
    .digest("base64url")
    .slice(0, 24)}`
}

/** Passes a provider-held artifact only; guests never receive inline data. */
function projectArtifact(
  candidate: TurnEventOf<typeof TurnEventKind.ArtifactPublished>
): TurnEventOf<typeof TurnEventKind.ArtifactPublished> | undefined {
  const { id, filename, mimeType, sizeBytes, source } = candidate.artifact
  if (
    !validIdentifier(id) ||
    source.type !== "provider" ||
    source.reference !== id
  )
    return undefined
  return {
    kind: TurnEventKind.ArtifactPublished,
    artifact: {
      id,
      filename,
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      source: { type: "provider", reference: id },
    },
  }
}

function createTurnProjector(
  scope: SessionScope,
  read: VerifiedGuestAuthorization,
  errors: VerifiedGuestAuthorization,
  now: () => number
) {
  // The names of the calls a guest saw start, so a flagged settling can name
  // the card even when the start itself was not flagged.
  const toolNames = new Map<string, string>()
  return (candidate: TurnEvent): TurnEvent | undefined => {
    if (
      !guestAuthorizationActive(read, now) ||
      !guestAuthorizationActive(errors, now) ||
      !isTurnEvent(candidate)
    )
      return undefined
    switch (candidate.kind) {
      case TurnEventKind.TurnStarted:
        return { kind: TurnEventKind.TurnStarted }
      // Why the turn stopped is the guest's to know; what it spent is not.
      case TurnEventKind.TurnEnded:
        return {
          kind: TurnEventKind.TurnEnded,
          ...(candidate.stopReason ? { stopReason: candidate.stopReason } : {}),
        }
      case TurnEventKind.MessageChunk: {
        // A subagent's prose is its tool call's output, which guests never see.
        if (
          !validIdentifier(candidate.messageId) ||
          candidate.subagentId !== undefined
        )
          return undefined
        const projected = projectGuestOutbound(
          {
            transport: "turn",
            agentId: scope.agentId,
            sessionId: scope.threadId,
            payload: {
              type: "message",
              role: "assistant",
              text: candidate.text,
            },
          },
          read
        )
        return projected?.payload.type === "message" &&
          projected.payload.text !== undefined
          ? {
              kind: TurnEventKind.MessageChunk,
              messageId: guestMessageId(read.tokenId, candidate.messageId),
              text: projected.payload.text,
            }
          : undefined
      }
      case TurnEventKind.TurnRequiresAction: {
        const projected = projectGuestOutbound(
          {
            transport: "turn",
            agentId: scope.agentId,
            sessionId: scope.threadId,
            payload: { type: "requests", requests: candidate.requests },
          },
          read
        )
        return projected?.payload.type === "requests"
          ? {
              kind: TurnEventKind.TurnRequiresAction,
              requests: [...projected.payload.requests],
            }
          : undefined
      }
      case TurnEventKind.TurnFailed: {
        const error = publicTurnError(candidate.code)
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
              kind: TurnEventKind.TurnFailed,
              code: projected.payload.code,
              message:
                projected.payload.description ??
                guestErrorDescription(projected.payload.code),
              ...(candidate.awaitingStop
                ? { awaitingStop: true as const }
                : {}),
            }
          : undefined
      }
      // Only an MCP App's card, from its start to its settling: no arguments,
      // no output, and no other tool call. The App's input and result reach
      // the guest through its view.
      case TurnEventKind.ToolCallStarted: {
        if (candidate.subagentId !== undefined) return undefined
        const name = candidate.name ?? candidate.title
        toolNames.set(candidate.toolCallId, name)
        return candidate.app
          ? {
              kind: TurnEventKind.ToolCallStarted,
              toolCallId: candidate.toolCallId,
              title: name,
              name,
              app: true,
            }
          : undefined
      }
      case TurnEventKind.ToolCallFinished: {
        const name = toolNames.get(candidate.toolCallId)
        return candidate.app && name !== undefined
          ? {
              kind: TurnEventKind.ToolCallFinished,
              toolCallId: candidate.toolCallId,
              output: "",
              failed: candidate.failed,
              app: true,
              name,
            }
          : undefined
      }
      case TurnEventKind.PlanUpdated:
        return { kind: TurnEventKind.PlanUpdated, todos: candidate.todos }
      case TurnEventKind.ArtifactPublished:
        return projectArtifact(candidate)
      default:
        return undefined
    }
  }
}

export function createGuestTurnAccess(
  read: VerifiedGuestAuthorization,
  errors: VerifiedGuestAuthorization,
  scope: SessionScope,
  now: () => number,
  subscriberId: string
): CoordinatorAccess {
  return {
    subscriberId,
    controllerId: guestControllerId(read),
    lane: "guest",
    canControl: true,
    project: createTurnProjector(scope, read, errors, now),
  }
}
