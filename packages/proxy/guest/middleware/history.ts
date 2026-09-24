import { z } from "zod"

import {
  SessionHistoryResponseSchema,
  type SessionHistoryResponse,
  type SessionMessage,
} from "../../../protocol"
import { guestErrorDescription } from "../../auth/guest-projection"
import {
  isFirstTurnEnvelope,
  publicTurnError,
} from "../../auth/guest-runtime-projection"
import { TurnEventKind } from "../../core/events"
import {
  CommandRefusedError,
  unhandledKind,
  type MemberEvent,
  type Middleware,
} from "../../core/member"
import type { GuestGrant } from "./index"

/**
 * What a guest reads of the invited conversation's history: every page it is
 * shown, validated and projected by main's guest history rules, and the only
 * user messages an Edit or Retry of its may name.
 */

/** The normalized turn failure code a restored failed turn carries, if any. */
function restoredTurnErrorCode(metadata: SessionMessage["metadata"]) {
  const aos = metadata?.custom.aos
  if (typeof aos !== "object" || aos === null || Array.isArray(aos))
    return undefined
  const code = (aos as Record<string, unknown>).turnErrorCode
  return typeof code === "string" ? code : undefined
}

/**
 * A replay from the start may join every page of the Session, each already
 * bounded as it was read, so only the page's own size limit is lifted.
 */
const ProjectedHistorySchema = SessionHistoryResponseSchema.extend({
  messages: z.array(SessionHistoryResponseSchema.shape.messages.element),
})

export function projectGuestHistory(
  history: SessionHistoryResponse,
  publicSessionId = history.sessionId
) {
  const messages: unknown[] = []
  for (const message of history.messages) {
    if (message.role === "system") continue
    // Pages count back from the newest, so the setup turn may open any page.
    if (message.role === "user" && isFirstTurnEnvelope(message.content))
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
        return part.type === "text" ? [{ type: "text", text: part.text }] : []
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
  return ProjectedHistorySchema.parse({
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

export type GuestHistoryOptions = { grant: GuestGrant }

export function createHistoryMiddleware({
  grant,
}: GuestHistoryOptions): Middleware {
  /**
   * Every user message this guest was shown, by each id it may know it by, so
   * an Edit or Retry never names the hidden setup turn or anything unseen.
   */
  const shown = new Set<string>()
  return {
    commands: {
      send: async (command, next) => {
        const { rewindSourceId } = command
        if (rewindSourceId !== undefined && !shown.has(rewindSourceId))
          throw new CommandRefusedError("invalid")
        return next(command)
      },
    },
    event(event): MemberEvent | undefined {
      switch (event.kind) {
        // The authoritative page is validated before anything reads it.
        case "history": {
          const page = projectGuestHistory(
            ProjectedHistorySchema.parse(event.page),
            grant.ref
          )
          for (const message of page.messages)
            if (message.role === "user") shown.add(message.id)
          return { ...event, page }
        }
        case "prompt":
          shown.add(event.messageId)
          return event
        // A user message is saved under a new id only once it was shown.
        case "turn": {
          const user =
            event.event.kind === TurnEventKind.TurnEnded
              ? event.event.saved?.user
              : undefined
          if (user && shown.has(user.messageId)) shown.add(user.savedId)
          return event
        }
        case "request-asked":
        case "request-withdrawn":
        case "question-answered":
        case "execution":
        case "usage":
        case "model":
        case "session-info":
        case "commands":
        case "invalidated":
        case "error":
          return event
      }
      return unhandledKind(event)
    },
  }
}
