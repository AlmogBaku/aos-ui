import {
  unhandledKind,
  type MemberEvent,
  type Middleware,
} from "../../core/member"

/**
 * The readings a guest is shown: its Session's execution, and its commands,
 * which say what the guest can do. Usage, models, the Session row, the
 * Session list's invalidation and the workspace's activity belong to the
 * operator's workspace, so a guest is given none of them. Every event that is
 * not a reading passes. An operator is given every reading by having no such
 * layer.
 */
export function createFeedsMiddleware(): Middleware {
  return {
    event(event): MemberEvent | undefined {
      switch (event.kind) {
        case "usage":
        case "model":
        case "session-info":
        case "catalog-invalidated":
        case "activity":
          return undefined
        case "execution":
        case "commands":
        case "turn":
        case "prompt":
        case "history":
        case "request-asked":
        case "request-withdrawn":
        case "question-answered":
        case "invalidated":
        case "error":
          return event
      }
      return unhandledKind(event)
    },
  }
}
