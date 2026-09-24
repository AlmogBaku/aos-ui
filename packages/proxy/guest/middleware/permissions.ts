import { PendingRequestKind } from "../../core/events"
import { CommandRefusedError, type Middleware } from "../../core/member"

/** The approval scopes the guest lane never carries, as the adapters name them. */
const GUEST_DENIED_CHOICES = new Set(["always", "session"])

/**
 * A guest may answer a permission only within the scope it was offered, so a
 * widened grant is refused the way the guest turn route refuses one.
 */
export function createPermissionsMiddleware(): Middleware {
  return {
    commands: {
      // Mirrors `guestResumeAllowed`: an answer may not carry a Session-wide
      // or Agent-wide approval even when the guest client names one.
      answer: async (command, next) => {
        const { request, reply } = command
        if (
          request.kind === PendingRequestKind.Permission &&
          typeof reply.payload === "string" &&
          GUEST_DENIED_CHOICES.has(reply.payload)
        )
          throw new CommandRefusedError("invalid")
        return next(command)
      },
    },
  }
}
