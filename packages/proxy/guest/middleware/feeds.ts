import {
  unhandledKind,
  type MemberEvent,
  type Middleware,
} from "../../core/member"

/**
 * The Session readings a guest is shown: its execution, and its commands,
 * which say what the guest can do. Usage, models and the Session row belong
 * to the operator's workspace, so a guest is given none of them. Every event
 * that is not a reading passes. An operator is given every reading by having
 * no such layer.
 */
export function createFeedsMiddleware(): Middleware {
  return {
    event(event): MemberEvent | undefined {
      switch (event.kind) {
        case "usage":
        case "model":
        case "session-info":
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
