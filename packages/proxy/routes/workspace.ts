import {
  RuntimeInfoSchema,
  SessionContextResponseSchema,
  SessionModelsResponseSchema,
  SessionModelSelectRequestSchema,
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
    const hermes = await requireRuntime(context.req.raw)
    return context.json(RuntimeInfoSchema.parse(await hermes.runtimeInfo()))
  })

  app.get("/api/aos/v1/agents", async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    return context.json(await hermes.listAgents())
  })

  app.patch("/api/aos/v1/agents/:agentId/visibility", async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const parsed = VisibilityUpdateRequestSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!parsed.success) return errorResponse("invalid_request", 400)
    return context.json(
      await hermes.updateAgentVisibility(
        context.req.param("agentId"),
        parsed.data.visibility,
        parsed.data.revision
      )
    )
  })

  const sessionWorkspacePath =
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/workspace"

  app.get(`${sessionWorkspacePath}/capabilities`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    const agentId = context.req.param("agentId")
    const sessionId = context.req.param("sessionId")
    await requireScopedSession(hermes, agentId, sessionId)
    return context.json(
      SessionWorkspaceCapabilitiesResponseSchema.parse(
        hermes.workspaceCapabilities()
      )
    )
  })

  app.get(`${sessionWorkspacePath}/models`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    const agentId = context.req.param("agentId")
    const sessionId = context.req.param("sessionId")
    await requireScopedSession(hermes, agentId, sessionId)
    return context.json(
      SessionModelsResponseSchema.parse(await hermes.models(agentId, sessionId))
    )
  })

  app.post(`${sessionWorkspacePath}/models/select`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const body = SessionModelSelectRequestSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionModelSelectRequestSchema.parse(
        await hermes.selectModel(
          context.req.param("agentId"),
          context.req.param("sessionId"),
          body.data.selectedId
        )
      )
    )
  })

  app.get(`${sessionWorkspacePath}/context`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionContextResponseSchema.parse(
        await hermes.context(
          context.req.param("agentId"),
          context.req.param("sessionId")
        )
      )
    )
  })
}
