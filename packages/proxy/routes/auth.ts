import type { GuestInvitationRequest } from "../auth/guest-invitation"
import { GuestInvitationError } from "../auth/guest-invitation"
import type { ProxyAppOptions } from "../app"
import { boundedJson, errorResponse } from "./http"
import type { ProxyRouteApp } from "./types"

/** Trusted operator ingress exposes only invitation creation in V1. */
export function registerAuthRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions
) {
  app.post("/api/aos/v1/guest-invitations", async (context) => {
    if (!options.guestInvitations) return errorResponse("not_found", 404)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const request = await boundedJson(context.req.raw, 16_384)
    if (!request || typeof request !== "object" || Array.isArray(request))
      return errorResponse("invalid_request", 400)
    try {
      const grant = request as GuestInvitationRequest
      if (grant.runtimeId !== options.runtimeInstance.id)
        return errorResponse("not_found", 404)
      const catalog = await options.runtimeInstance.runtime.listAgents()
      if (!catalog.agents.some(({ summary }) => summary.id === grant.agentId))
        return errorResponse("not_found", 404)
      if (grant.sessionId) {
        const runtime = options.runtimeInstance.runtime
        const storedId = runtime.resolveSessionId(
          grant.agentId,
          grant.sessionId
        )
        if (!storedId) return errorResponse("not_found", 404)
        await runtime.getSession(grant.agentId, storedId)
      }
      return context.json(await options.guestInvitations.issue(grant), 201)
    } catch (error) {
      if (error instanceof GuestInvitationError)
        return errorResponse("invalid_request", 400)
      throw error
    }
  })
}
