import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"
import {
  isFirstTurnEnvelopeText,
  projectGuestCapabilities,
} from "../../auth/guest-runtime-projection"
import {
  CommandRefusedError,
  type CommandKind,
  type Middleware,
  type WorkspaceCapabilities,
} from "../../core/member"

/**
 * What a guest may ask at all. The guest lane holds one invited conversation
 * and manages no workspace: it owns no roster, no read state, no catalog, and
 * no model or effort.
 */
const GUEST_COMMANDS: Readonly<Record<CommandKind, boolean>> = {
  resume: true,
  "older-page": true,
  send: true,
  stop: true,
  close: true,
  answer: true,
  focus: true,
  steer: true,
  list: false,
  new: false,
  delete: false,
  update: false,
  "set-config": false,
  agents: false,
  "update-agent": false,
}

/** What a guest may observe but never operate. */
const OPERATOR_ONLY = {
  status: "unavailable",
  reason: "operator-session-controls-required",
} as const

/** Leading whitespace, and the invisible characters `trimStart` keeps. */
const LEADING_PADDING = /^[\s\u200B\u2060\uFEFF]+/u

/**
 * Text a guest may not send or steer with: a slash command, which the runtime
 * would run as the operator, or an invitation envelope, however either is
 * padded. The padding is stripped for this check alone; the text travels as
 * written.
 */
function refusedText(text: string) {
  return (
    text.replace(LEADING_PADDING, "").startsWith("/") ||
    isFirstTurnEnvelopeText(text)
  )
}

/**
 * The invited Session's capabilities, projected to what the guest lane serves.
 * The member contract carries the workspace shape, so the fields the REST
 * projection drops outright are reported unavailable here instead. A guest
 * steers the conversation as an operator does, and runs no slash command.
 */
function projectCapabilities(
  value: WorkspaceCapabilities
): WorkspaceCapabilities {
  const projected = projectGuestCapabilities(value)
  if (!projected)
    throw new Error("The invited Session reported unusable capabilities")
  return SessionWorkspaceCapabilitiesResponseSchema.parse({
    workspace: {
      slashCommands: OPERATOR_ONLY,
      models: OPERATOR_ONLY,
      context: OPERATOR_ONLY,
      todos: value.workspace.todos,
      activity: value.workspace.activity,
    },
    interactions: {
      ...projected.interactions,
      steering: value.interactions.steering,
    },
    content: projected.content,
  })
}

export function createCommandsMiddleware(): Middleware {
  return {
    admits: (kind) => GUEST_COMMANDS[kind],
    commands: {
      resume: async (command, next) => {
        const resumed = await next(command)
        return {
          ...resumed,
          capabilities: projectCapabilities(resumed.capabilities),
        }
      },
      // Rebuilt from the fields a guest may set; the history layer decides
      // which message an Edit or Retry may name.
      send: async (command, next) => {
        const { sessionId, content, text, rewindSourceId, attachmentStageId } =
          command
        if (
          [
            text,
            ...content.flatMap((part) =>
              part.kind === "text" ? [part.text] : []
            ),
          ].some(refusedText)
        )
          throw new CommandRefusedError("invalid")
        return next({
          sessionId,
          content,
          text,
          ...(rewindSourceId === undefined ? {} : { rewindSourceId }),
          ...(attachmentStageId === undefined ? {} : { attachmentStageId }),
        })
      },
      steer: async ({ sessionId, requestId, text }, next) => {
        if (refusedText(text)) throw new CommandRefusedError("invalid")
        return next({ sessionId, requestId, text })
      },
      // Read state belongs to the operator; a guest's exposure moves nothing.
      focus: async () => undefined,
    },
  }
}
