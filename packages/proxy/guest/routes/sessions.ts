import type { Hono } from "hono"

import { SessionHistoryResponseSchema } from "../../../protocol"
import { projectGuestHistory } from "../../auth/guest-runtime-projection"
import { loadSessionHistory } from "../../routes/sessions"
import {
  emptyError,
  guestPageQuery,
  invitationError,
  type GuestRoutes,
} from "../context"

export function registerGuestSessionRoutes(app: Hono, routes: GuestRoutes) {
  app.get(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/history",
    async (context) => {
      const identity = await routes.authenticate(context.req.raw)
      if (!identity) return invitationError()
      const agentId = context.req.param("agentId")
      const ref = context.req.param("sessionId")
      const authorization = routes.authorize(
        identity,
        agentId,
        ref,
        "messages:read"
      )
      if (!authorization) return emptyError(401)
      const page = guestPageQuery(context.req.url)
      if (!page) return emptyError(400)
      const resolved =
        await routes.options.runtime.runtime.resolveInvitedSession(agentId, ref)
      if (!resolved)
        return context.json(
          SessionHistoryResponseSchema.parse({
            sessionId: ref,
            messages: [],
            total: 0,
            limit: page.limit,
            offset: page.offset,
            nextOffset: 0,
            execution: { status: "idle" },
          })
        )
      try {
        const history = SessionHistoryResponseSchema.parse(
          await loadSessionHistory(
            routes.options.runtime,
            routes.options.runtime.runtime,
            { agentId, sessionId: resolved.sessionId, threadId: ref },
            page
          )
        )
        return context.json(projectGuestHistory(history, authorization, ref))
      } catch {
        return routes.projectedError(
          identity,
          agentId,
          ref,
          "temporarily_unavailable",
          true,
          503
        )
      }
    }
  )
}
