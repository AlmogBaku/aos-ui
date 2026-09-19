import {
  RuntimeInfoSchema,
  SessionContextResponseSchema,
  SessionModelsResponseSchema,
  SessionModelUpdateRequestSchema,
  SessionModelUpdateResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  VisibilityUpdateRequestSchema,
} from "../../protocol"
import type { ProxyAppOptions } from "../app"
import type { ServerRuntime } from "../core/runtime"
import { boundedJson, errorResponse } from "./http"
import type { ProxyRouteApp } from "./types"

export function registerWorkspaceRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  requireRuntime: (request: Request) => Promise<ServerRuntime>,
  requireScopedSession: (
    runtime: ServerRuntime,
    agentId: string,
    sessionId: string
  ) => Promise<string>
) {
  app.get("/api/aos/v1/runtime", async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    return context.json(RuntimeInfoSchema.parse(await runtime.runtimeInfo()))
  })

  app.get("/api/aos/v1/agents", async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    return context.json(await runtime.listAgents())
  })

  app.patch("/api/aos/v1/agents/:agentId/visibility", async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const parsed = VisibilityUpdateRequestSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!parsed.success) return errorResponse("invalid_request", 400)
    return context.json(
      await runtime.updateAgentVisibility(
        context.req.param("agentId"),
        parsed.data.visibility,
        parsed.data.revision
      )
    )
  })

  const sessionWorkspacePath =
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/workspace"

  app.get(`${sessionWorkspacePath}/capabilities`, async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    const agentId = context.req.param("agentId")
    const sessionId = context.req.param("sessionId")
    await requireScopedSession(runtime, agentId, sessionId)
    return context.json(
      SessionWorkspaceCapabilitiesResponseSchema.parse(
        await runtime.workspaceCapabilities(agentId, sessionId)
      )
    )
  })

  app.get(`${sessionWorkspacePath}/models`, async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    const agentId = context.req.param("agentId")
    const sessionId = context.req.param("sessionId")
    await requireScopedSession(runtime, agentId, sessionId)
    return context.json(
      SessionModelsResponseSchema.parse(
        await runtime.models(agentId, sessionId)
      )
    )
  })

  // One resource, one write: the model and its reasoning effort are halves of
  // the same Session model state, and the response is that state afterwards.
  app.patch(`${sessionWorkspacePath}/models`, async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const body = SessionModelUpdateRequestSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    await requireScopedSession(
      runtime,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionModelUpdateResponseSchema.parse(
        await runtime.updateModel(
          context.req.param("agentId"),
          context.req.param("sessionId"),
          body.data
        )
      )
    )
  })

  app.get(`${sessionWorkspacePath}/context`, async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    await requireScopedSession(
      runtime,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionContextResponseSchema.parse(
        await runtime.context(
          context.req.param("agentId"),
          context.req.param("sessionId")
        )
      )
    )
  })
}
