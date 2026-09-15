import type { GuestInvitationService } from "../auth/guest-invitation"
import {
  InvitationLinkError,
  issueInvitationLink,
} from "../auth/invitation-link"
import type { ServerRuntime } from "../core/runtime"
import { boundedJson, errorResponse } from "./http"
import type { ProxyRouteApp } from "./types"

export function registerInvitationRoutes(
  app: ProxyRouteApp,
  options: {
    publicOrigin: string
    guestPublicOrigin: string
    invitations: GuestInvitationService
    runtime: ServerRuntime
  }
) {
  app.post("/api/aos/v1/guest-invitations", async (context) => {
    const origin = context.req.header("origin")
    if (origin !== options.publicOrigin) return errorResponse("forbidden", 403)
    const input = await boundedJson(context.req.raw)
    if (input === undefined) return errorResponse("invalid_request", 400)
    try {
      const invitation = await issueInvitationLink(input, {
        invitations: options.invitations,
        publicOrigin: options.guestPublicOrigin,
      })
      const catalog = await options.runtime.listAgents()
      if (
        !catalog.agents.some(({ summary }) => summary.id === invitation.agentId)
      )
        return errorResponse("not_found", 404)
      return context.json({ url: invitation.url }, 201)
    } catch (error) {
      if (error instanceof InvitationLinkError)
        return errorResponse("invalid_request", 400)
      throw error
    }
  })
}
