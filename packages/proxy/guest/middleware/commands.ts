import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"
import { projectGuestCapabilities } from "../../auth/guest-runtime-projection"
import {
  CommandRefusedError,
  type CommandKind,
  type Middleware,
  type WorkspaceCapabilities,
} from "../../core/member"

/**
 * What a guest may ask at all. The guest lane streams one invited conversation
 * and manages no workspace: it owns no roster, no read state, no catalog, and
 * no turn control beyond Stop.
 */
const GUEST_COMMANDS: Readonly<Record<CommandKind, boolean>> = {
  resume: true,
  "older-page": true,
  send: true,
  stop: true,
  close: true,
  answer: true,
  focus: true,
  steer: false,
  list: false,
  new: false,
  delete: false,
  update: false,
  "set-config": false,
  agents: false,
  "set-visibility": false,
}

/** What a guest may observe but never operate. */
const OPERATOR_ONLY = {
  status: "unavailable",
  reason: "operator-session-controls-required",
} as const

/**
 * The invited Session's capabilities, projected to what the guest lane serves.
 * The member contract carries the workspace shape, so the fields the REST
 * projection drops outright are reported unavailable here instead.
 */
function projectCapabilities(
  value: WorkspaceCapabilities
): WorkspaceCapabilities {
  const projected = projectGuestCapabilities(value)
  if (!projected)
    throw new Error("The invited Session reported unusable capabilities")
  return SessionWorkspaceCapabilitiesResponseSchema.parse({
    workspace: {
      slashCommands: projected.workspace.slashCommands,
      models: OPERATOR_ONLY,
      context: OPERATOR_ONLY,
      todos: value.workspace.todos,
      activity: value.workspace.activity,
    },
    interactions: projected.interactions,
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
      // Rewind stays operator-only, exactly as the guest turn route refuses one.
      send: async (command, next) => {
        if (command.rewindSourceId !== undefined)
          throw new CommandRefusedError("invalid")
        return next(command)
      },
      // Read state belongs to the operator; a guest's exposure moves nothing.
      focus: async () => undefined,
    },
  }
}
