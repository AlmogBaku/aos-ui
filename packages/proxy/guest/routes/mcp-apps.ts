import type { Hono } from "hono"

import type { GuestOperation } from "../../auth/guest-invitation"
import * as ids from "../../core/ids"
import { ServerSessionNotFoundError } from "../../core/runtime"
import { answerAppFile, type AppFileGrant } from "../../routes/app-files"
import {
  createMcpAppLimits,
  handleMcpAppRequest,
  MCP_APP_PATH,
  mcpAppParams,
  type McpAppOperation,
} from "../../routes/mcp-apps"
import { emptyError, invitationError, type GuestRoutes } from "../context"

/**
 * The guest listener's MCP App views: the invite's own Session only, read like
 * its artifacts, and a view's tool call authorized like the guest's own
 * message.
 */
export function registerGuestMcpAppRoutes(app: Hono, routes: GuestRoutes) {
  const base = `/api/guest/v1/agents/:agentId/sessions/:sessionId${MCP_APP_PATH}`
  const limit = createMcpAppLimits(
    routes.options.now,
    routes.options.files?.ratePerSecond
  )
  const runtime = routes.options.runtime.runtime
  const guestRoutes: Array<
    [method: "get" | "post", path: string, McpAppOperation, GuestOperation]
  > = [
    ["get", base, "open", "artifacts:read"],
    ["post", `${base}/tools/call`, "tools/call", "messages:create"],
    ["post", `${base}/resources/read`, "resources/read", "artifacts:read"],
  ]
  const configured = routes.options.files
  const files: AppFileGrant | undefined = configured && {
    options: configured,
    role: "guest",
    root: "/api/guest/v1",
    // A guest reads only what an operator may read too.
    sets: [configured.guest, configured.operator],
    requiresRealPath: true,
  }
  if (files) {
    guestRoutes.push(["post", `${base}/files`, "files", "artifacts:read"])
    app.get(`${base}/files/:argument`, async (context) => {
      const target = mcpAppParams(context.req.param())
      const argument = context.req.param("argument")
      if (!target || !argument) return emptyError(404)
      const { agentId, sessionId: ref } = target
      return answerAppFile({
        request: context.req.raw,
        runtime,
        grant: files,
        target,
        argument,
        allow: limit("files"),
        login: async () => {
          const identity = await routes.authenticate(context.req.raw)
          return Boolean(
            identity &&
            routes.authorize(identity, agentId, ref, "artifacts:read")
          )
        },
        scope: async () => {
          const resolved = await runtime.resolveInvitedSession(agentId, ref)
          if (!resolved) throw new ServerSessionNotFoundError()
          return {
            agentId,
            providerSessionId: resolved.providerSessionId,
            sessionId: ids.sessionId(ref),
          }
        },
      })
    })
  }
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
        scope: {
          agentId,
          providerSessionId: resolved.providerSessionId,
          sessionId: ids.sessionId(ref),
        },
        toolCallId,
        operation,
        request: context.req.raw,
        allow: limit(operation),
        files,
        // A pass ends with the invitation that earned it.
        notAfter: identity.authorizationExpiresAt,
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
