import { createHash } from "node:crypto"

import {
  guestErrorDescription,
  projectGuestOutbound,
} from "../../auth/guest-projection"
import type { VerifiedGuestAuthorization } from "../../auth/guest-invitation"
import { guestAuthorizationActive } from "../../auth/guest-request"
import {
  projectGuestText,
  publicTurnError,
} from "../../auth/guest-runtime-projection"
import {
  isTurnEvent,
  TurnEventKind,
  type TurnEvent,
  type TurnEventOf,
} from "../../core/events"
import {
  promptText,
  type MemberEvent,
  type Middleware,
  type TurnStream,
} from "../../core/member"
import { validIdentifier } from "../../routes/http"
import type { GuestGrant } from "./index"

/**
 * What a guest is shown of a live turn: the run projection the guest REST
 * routes apply, another member's prompt as its history shows a user turn, and
 * each request it is asked without approval internals.
 */

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

/** The invited conversation a projected event describes. */
type InvitedScope = { agentId: string; threadId: string }

export function createTurnProjector(
  scope: InvitedScope,
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
      // Reasoning, a call's input and output, terminals, compaction, the
      // model, subagents and steer acknowledgements are never a guest's.
      case TurnEventKind.ThoughtChunk:
      case TurnEventKind.ToolCallInputChunk:
      case TurnEventKind.ToolCallInputEnded:
      case TurnEventKind.ToolCallOutputChunk:
      case TurnEventKind.TerminalOutput:
      case TurnEventKind.CompactionUpdated:
      case TurnEventKind.ModelChanged:
      case TurnEventKind.SubagentUpdated:
      case TurnEventKind.SteerAccepted:
        return undefined
    }
  }
}

export type GuestTurnsOptions = {
  grant: GuestGrant
  read: VerifiedGuestAuthorization
  errors: VerifiedGuestAuthorization
  now: () => number
}

export function createTurnsMiddleware({
  grant,
  read,
  errors,
  now,
}: GuestTurnsOptions): Middleware {
  const scope = { agentId: grant.agentId, threadId: grant.ref }
  /** One projector per turn stream, so a stream never reads another's calls. */
  const projectors = new WeakMap<
    TurnStream,
    ReturnType<typeof createTurnProjector>
  >()
  const projectorOf = (stream: TurnStream) => {
    const existing = projectors.get(stream)
    if (existing) return existing
    const created = createTurnProjector(scope, read, errors, now)
    projectors.set(stream, created)
    return created
  }

  return {
    event(event): MemberEvent | undefined {
      switch (event.kind) {
        case "turn": {
          const shown = projectorOf(event.stream)(event.event)
          return shown && { ...event, event: shown }
        }
        // Another member's prompt reaches a guest as its history shows a user
        // turn: the text alone, and nothing once the invitation lapsed.
        case "prompt": {
          if (event.own) return event
          const text = guestAuthorizationActive(read, now)
            ? projectGuestText(read, "guest", promptText(event.content))
            : undefined
          return text === undefined
            ? undefined
            : { ...event, content: [{ kind: "text", text }] }
        }
        case "request-asked": {
          const projected = projectGuestOutbound(
            {
              transport: "turn",
              agentId: scope.agentId,
              sessionId: scope.threadId,
              payload: { type: "requests", requests: [event.request] },
            },
            read
          )
          const request =
            projected?.payload.type === "requests"
              ? projected.payload.requests[0]
              : undefined
          return request && { ...event, request }
        }
        // A model reading follows the model change the projector hides.
        case "model":
          return undefined
        case "history":
        case "request-withdrawn":
        case "question-answered":
        case "execution":
        case "usage":
        case "session-info":
        case "commands":
        case "invalidated":
        case "error":
          return event
      }
    },
  }
}
