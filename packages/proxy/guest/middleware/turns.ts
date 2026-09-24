import { guestErrorDescription } from "../../auth/guest-projection"
import { publicTurnError } from "../../auth/guest-runtime-projection"
import {
  isTurnEvent,
  TurnEventKind,
  type TurnEvent,
  type TurnEventOf,
} from "../../core/events"
import {
  promptText,
  unhandledKind,
  type MemberEvent,
  type Middleware,
} from "../../core/member"
import { validIdentifier } from "../../routes/http"

/**
 * What a guest is shown of a live turn: the conversation's own text whole,
 * under the runtime's ids, an MCP App's card, and nothing of how the turn ran.
 * Another member's prompt reaches it as its history shows a user turn.
 */

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

/**
 * One turn stream's projector. `shown` collects the calls whose card a guest
 * was shown, across every stream of the member.
 */
export function createTurnProjector(shown: Set<string> = new Set()) {
  return (candidate: TurnEvent): TurnEvent | undefined => {
    if (!isTurnEvent(candidate)) return undefined
    switch (candidate.kind) {
      case TurnEventKind.TurnStarted:
        return {
          kind: TurnEventKind.TurnStarted,
          ...(candidate.startedAt ? { startedAt: candidate.startedAt } : {}),
        }
      // How the turn stopped, what it was saved as, and what the runtime asks
      // the composer to start with are the guest's; what it spent is not.
      case TurnEventKind.TurnEnded: {
        const { stopReason, composerPrefill, saved } = candidate
        return {
          kind: TurnEventKind.TurnEnded,
          ...(stopReason ? { stopReason } : {}),
          ...(composerPrefill === undefined ? {} : { composerPrefill }),
          ...(saved ? { saved } : {}),
        }
      }
      // A subagent's prose is its tool call's output, which guests never see.
      case TurnEventKind.MessageChunk:
        return validIdentifier(candidate.messageId) &&
          candidate.subagentId === undefined
          ? {
              kind: TurnEventKind.MessageChunk,
              messageId: candidate.messageId,
              text: candidate.text,
            }
          : undefined
      // The permissions layer already took the permissions out.
      case TurnEventKind.TurnRequiresAction:
        return candidate
      case TurnEventKind.TurnFailed: {
        const { code } = publicTurnError(candidate.code)
        return {
          kind: TurnEventKind.TurnFailed,
          code,
          message: guestErrorDescription(code),
          ...(candidate.awaitingStop ? { awaitingStop: true as const } : {}),
        }
      }
      // Only an MCP App's card, from its start to its settling: its name, no
      // arguments, no output, and no other tool call. The App's input and
      // result reach the guest through its view.
      case TurnEventKind.ToolCallStarted: {
        if (!candidate.app || candidate.subagentId !== undefined)
          return undefined
        const name = candidate.name ?? candidate.title
        shown.add(candidate.toolCallId)
        return {
          kind: TurnEventKind.ToolCallStarted,
          toolCallId: candidate.toolCallId,
          title: name,
          name,
          app: true,
        }
      }
      // A settling whose start the guest was not shown has no card to settle.
      case TurnEventKind.ToolCallFinished:
        return shown.has(candidate.toolCallId)
          ? {
              kind: TurnEventKind.ToolCallFinished,
              toolCallId: candidate.toolCallId,
              output: "",
              failed: candidate.failed,
              app: true,
            }
          : undefined
      case TurnEventKind.PlanUpdated:
        return { kind: TurnEventKind.PlanUpdated, todos: candidate.todos }
      case TurnEventKind.ArtifactPublished:
        return projectArtifact(candidate)
      // A correction is the conversation's own text, whoever steered.
      case TurnEventKind.SteerAccepted:
        return candidate
      // Reasoning, a call's input and output, terminals, compaction, the
      // model and subagents are never a guest's.
      case TurnEventKind.ThoughtChunk:
      case TurnEventKind.ToolCallInputChunk:
      case TurnEventKind.ToolCallInputEnded:
      case TurnEventKind.ToolCallOutputChunk:
      case TurnEventKind.TerminalOutput:
      case TurnEventKind.CompactionUpdated:
      case TurnEventKind.ModelChanged:
      case TurnEventKind.SubagentUpdated:
        return undefined
    }
    return unhandledKind(candidate)
  }
}

export function createTurnsMiddleware(): Middleware {
  /**
   * Every call whose card this guest was shown. It grows with the one invited
   * conversation alone, which is all a guest's member ever reaches.
   */
  const shown = new Set<string>()
  const project = createTurnProjector(shown)

  return {
    event(event): MemberEvent | undefined {
      switch (event.kind) {
        case "turn": {
          const projected = project(event.event)
          return projected && { ...event, event: projected }
        }
        // Another member's prompt reaches a guest as its history shows a user
        // turn: its text alone, whole.
        case "prompt": {
          if (event.own) return event
          const text = promptText(event.content)
          return text
            ? { ...event, content: [{ kind: "text", text }] }
            : undefined
        }
        // An answer settles the call that asked it, which a guest may not see.
        case "question-answered":
          return event.request.toolCallId === undefined ||
            shown.has(event.request.toolCallId)
            ? event
            : undefined
        case "request-asked":
        case "history":
        case "request-withdrawn":
        case "execution":
        case "usage":
        case "model":
        case "invalidated":
        case "error":
          return event
        // A Session row and a command list come from the operator's catalog
        // and its Session creation, which are never a guest's.
        case "session-info":
        case "commands":
          return undefined
      }
      return unhandledKind(event)
    },
  }
}
