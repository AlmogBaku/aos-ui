import type { Hono } from "hono"

import type { GuestOperation } from "../../auth/guest-invitation"
import {
  createMcpAppRateLimit,
  handleMcpAppRequest,
  MCP_APP_PATH,
  mcpAppParams,
  type McpAppOperation,
} from "../../routes/mcp-apps"
import { emptyError, invitationError, type GuestRoutes } from "../context"

/**
 * The guest lane's MCP App views: the invite's own Session only, read like its
 * artifacts, and a view's tool call authorized like the guest's own message.
 */
export function registerGuestMcpAppRoutes(app: Hono, routes: GuestRoutes) {
  const base = `/api/guest/v1/agents/:agentId/sessions/:sessionId${MCP_APP_PATH}`
  const allow = createMcpAppRateLimit(routes.options.now)
  const runtime = routes.options.runtime.runtime
  const guestRoutes: Array<
    [method: "get" | "post", path: string, McpAppOperation, GuestOperation]
  > = [
    ["get", base, "open", "artifacts:read"],
    ["post", `${base}/tools/call`, "tools/call", "messages:create"],
    ["post", `${base}/resources/read`, "resources/read", "artifacts:read"],
  ]
  for (const [method, path, operation, permission] of guestRoutes)
    app[method](path, async (context) => {
      if (
        method === "post" &&
        context.req.header("origin") !== routes.options.publicOrigin
      )
        return emptyError(403)
      const identity = await routes.authenticate(context.req.raw)
      if (!identity) return invitationError()
      const params = mcpAppParams(context.req.param())
      if (!params) return emptyError(404)
      const { agentId, sessionId: ref, toolCallId } = params
      if (!routes.authorize(identity, agentId, ref, permission))
        return emptyError(401)
      const resolved = await runtime.resolveInvitedSession(agentId, ref)
      if (!resolved) return emptyError(404)
      const outcome = await handleMcpAppRequest({
        runtime,
        scope: { agentId, sessionId: resolved.sessionId, threadId: ref },
        toolCallId,
        operation,
        request: context.req.raw,
        allow,
      })
      if (outcome.ok) return context.json(outcome.body)
      return outcome.reason === "invalid_request"
        ? emptyError(400)
        : routes.projectedError(
            identity,
            agentId,
            ref,
            outcome.reason,
            outcome.status === 429 || outcome.status === 503,
            outcome.status
          )
    })
}
