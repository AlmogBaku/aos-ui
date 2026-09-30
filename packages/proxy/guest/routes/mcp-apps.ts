import type { Hono } from "hono"

import type {
  GuestAuthorization,
  GuestOperation,
} from "../../auth/guest-invitation"
import * as ids from "../../core/ids"
import {
  ServerSessionNotFoundError,
  type ServerRuntime,
} from "../../core/runtime"
import {
  answerAppFile,
  type AppFileGrant,
  type AppSubject,
  type AppTarget,
} from "../../routes/app-files"
import {
  createMcpAppLimits,
  handleMcpAppRequest,
  mcpAppParams,
  mcpAppRoutes,
} from "../../routes/mcp-apps"
import { emptyError, invitationError, type GuestRoutes } from "../context"
import { projectedArtifact } from "./content"

/**
 * The subject a guest path names. An Artifact reads as the guest content
 * route reads it; given the request's `authorization`, its name and type are
 * the projected ones, and one the projection refuses fails as unavailable.
 * A file read by pass alone has no authorization, and its pass was earned by
 * an `open` that projected the same Artifact.
 */
function guestSubject(
  runtime: ServerRuntime,
  target: AppTarget,
  authorization?: GuestAuthorization
): AppSubject {
  if ("toolCallId" in target) return { toolCallId: target.toolCallId }
  const { agentId, sessionId: ref, artifactId } = target
  return {
    artifactId,
    read: async (scope) => {
      const artifact = await runtime.artifact(
        agentId,
        scope.providerSessionId,
        artifactId
      )
      if (!authorization) return artifact
      const projected = projectedArtifact(artifact, agentId, ref, authorization)
      if (!projected)
        throw new Error("The guest projection refused an Artifact")
      return {
        bytes: artifact.bytes,
        filename: projected.name,
        mimeType: projected.mediaType,
      }
    },
  }
}

/**
 * The guest listener's MCP App views: the invite's own Session only, read like
 * its artifacts, and a view's tool call authorized like the guest's own
 * message.
 */
export function registerGuestMcpAppRoutes(app: Hono, routes: GuestRoutes) {
  const limit = createMcpAppLimits(
    routes.options.now,
    routes.options.files?.ratePerSecond
  )
  const runtime = routes.options.runtime.runtime
  const configured = routes.options.files
  const files: AppFileGrant | undefined = configured && {
    options: configured,
    role: "guest",
    root: "/api/guest/v1",
    // A guest reads only what an operator may read too.
    sets: [configured.guest, configured.operator],
    requiresRealPath: true,
  }
  const { routes: guestRoutes, filePaths } = mcpAppRoutes(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId",
    Boolean(files)
  )
  if (files)
    for (const path of filePaths)
      app.get(path, async (context) => {
        const target = mcpAppParams(context.req.param())
        const argument = context.req.param("argument")
        if (!target || !argument) return emptyError(404)
        const { agentId, sessionId: ref } = target
        return answerAppFile({
          request: context.req.raw,
          runtime,
          grant: files,
          target: { agentId, sessionId: ref },
          subject: guestSubject(runtime, target),
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
  for (const [method, path, operation] of guestRoutes) {
    const permission: GuestOperation =
      operation === "tools/call" ? "messages:create" : "artifacts:read"
    app[method](path, async (context) => {
      if (
        method === "post" &&
        context.req.header("origin") !== routes.options.publicOrigin
      )
        return emptyError(403)
      const identity = await routes.authenticate(context.req.raw)
      if (!identity) return invitationError()
      const target = mcpAppParams(context.req.param())
      if (!target) return emptyError(404)
      const { agentId, sessionId: ref } = target
      const authorization = routes.authorize(identity, agentId, ref, permission)
      if (!authorization) return emptyError(401)
      const resolved = await runtime.resolveInvitedSession(agentId, ref)
      if (!resolved) return emptyError(404)
      const outcome = await handleMcpAppRequest({
        runtime,
        scope: {
          agentId,
          providerSessionId: resolved.providerSessionId,
          sessionId: ids.sessionId(ref),
        },
        subject: guestSubject(runtime, target, authorization),
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
}
