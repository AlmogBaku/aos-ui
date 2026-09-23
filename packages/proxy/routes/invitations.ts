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
    // Browsers always send Origin on a POST, so a foreign Origin is a
    // cross-site request and is refused. Non-browser callers (the invite
    // skill, a CLI) send none and were never stopped by this check anyway —
    // they could forge it — so requiring it only broke them.
    const origin = context.req.header("origin")
    if (origin !== undefined && origin !== options.publicOrigin)
      return errorResponse(
        "forbidden",
        403,
        `Origin ${origin} is not allowed; omit the Origin header or send ${options.publicOrigin}.`
      )
    const input = await boundedJson(context.req.raw)
    if (input === undefined)
      return errorResponse(
        "invalid_request",
        400,
        "Body must be a JSON object (content-type: application/json, at most 16 KiB)."
      )
    try {
      const invitation = await issueInvitationLink(input, {
        invitations: options.invitations,
        publicOrigin: options.guestPublicOrigin,
      })
      const catalog = await options.runtime.listAgents()
      if (
        !catalog.agents.some(({ summary }) => summary.id === invitation.agentId)
      )
        return errorResponse(
          "not_found",
          404,
          `agent: no Agent named ${invitation.agentId}`
        )
      return context.json({ url: invitation.url }, 201)
    } catch (error) {
      if (error instanceof InvitationLinkError)
        return errorResponse("invalid_request", 400, error.message)
      throw error
    }
  })
}
