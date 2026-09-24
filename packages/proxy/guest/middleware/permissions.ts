import {
  PendingRequestKind,
  TurnEventKind,
  type PendingRequest,
} from "../../core/events"
import {
  CommandRefusedError,
  unhandledKind,
  type MemberEvent,
  type Middleware,
} from "../../core/member"
import type { GuestGrant } from "./index"

/**
 * A guest answers no permission. One its own turn raises is declined for it,
 * and one another member's turn raises stays that member's to answer; either
 * way the guest is shown nothing of it. Questions are the conversation's and
 * pass whole.
 */

function isPermission(request: PendingRequest) {
  switch (request.kind) {
    case PendingRequestKind.Permission:
      return true
    case PendingRequestKind.Elicitation:
      return false
  }
  return unhandledKind(request.kind) ?? false
}

export function createPermissionsMiddleware({
  grant,
}: {
  grant: GuestGrant
}): Middleware {
  return {
    commands: {
      answer: async (command, next) => {
        if (isPermission(command.request))
          throw new CommandRefusedError("invalid")
        return next(command)
      },
    },
    event(event, act): MemberEvent | undefined {
      switch (event.kind) {
        case "request-asked":
          if (!isPermission(event.request)) return event
          if (event.startedBy === grant.principalId)
            act.decline(event.request.requestId)
          return undefined
        case "turn": {
          if (event.event.kind !== TurnEventKind.TurnRequiresAction)
            return event
          const requests = event.event.requests.filter(
            (request) => !isPermission(request)
          )
          return requests.length > 0
            ? { ...event, event: { ...event.event, requests } }
            : undefined
        }
        case "prompt":
        case "history":
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
