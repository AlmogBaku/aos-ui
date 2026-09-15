import type { Hono } from "hono"

import { projectGuestCapabilities } from "../../auth/guest-runtime-projection"
import { emptyError, invitationError, type GuestRoutes } from "../context"

export function registerGuestRuntimeRoute(app: Hono, routes: GuestRoutes) {
  app.get("/api/guest/v1/runtime", async (context) => {
    const identity = await routes.authenticate(context.req.raw)
    if (!identity) return invitationError()
    const resolved = await routes.options.runtime.runtime.resolveInvitedSession(
      identity.agentId,
      identity.ref
    )
    const capabilities = projectGuestCapabilities(
      routes.options.runtime.runtime.workspaceCapabilities()
    )
    if (!capabilities) return emptyError(503)
    return context.json({
      runtimeId: identity.runtimeId,
      agentId: identity.agentId,
      conversationRef: identity.ref,
      ...(resolved
        ? { session: { id: identity.ref, created: resolved.created } }
        : {}),
      ui: identity.ui ?? {},
      ...(!resolved && identity.firstTurn?.prefill
        ? { prefill: identity.firstTurn.prefill }
        : {}),
      capabilities,
      expiresAt: new Date(identity.expiresAt * 1_000).toISOString(),
    })
  })
}
