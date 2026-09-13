import {
  SessionCommandsResponseSchema,
  SessionCreateRequestSchema,
  SessionPatchRequestSchema,
  SESSION_CATALOG_MAX_WINDOW,
} from "../../protocol"
import type { ProxyAppOptions } from "../app"
import type { ServerRuntime } from "../runtime"
import { boundedJson, errorResponse, pageQuery } from "./http"
import type { ProxyRouteApp } from "./types"

export function registerSessionRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  requireRuntime: (request: Request) => Promise<ServerRuntime>
) {
  app.get("/api/aos/v1/sessions", async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    const page = pageQuery(
      context.req.url,
      { limit: 50, offset: 0 },
      100,
      SESSION_CATALOG_MAX_WINDOW
    )
    if (!page) return errorResponse("invalid_request", 400)
    return context.json(await hermes.listAllSessions(page.limit, page.offset))
  })

  app.get("/api/aos/v1/agents/:agentId/sessions", async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    const page = pageQuery(
      context.req.url,
      { limit: 50, offset: 0 },
      100,
      SESSION_CATALOG_MAX_WINDOW
    )
    if (!page) return errorResponse("invalid_request", 400)
    return context.json(
      await hermes.listSessions(
        context.req.param("agentId"),
        page.limit,
        page.offset
      )
    )
  })

  app.get(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/history",
    async (context) => {
      const hermes = await requireRuntime(context.req.raw)
      const storedId = hermes.resolveSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!storedId) return errorResponse("not_found", 404)
      const page = pageQuery(context.req.url, { limit: 200, offset: 0 }, 500)
      if (!page) return errorResponse("invalid_request", 400)
      return context.json(
        await hermes.history(
          context.req.param("agentId"),
          storedId,
          page.limit,
          page.offset
        )
      )
    }
  )

  app.get(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/commands",
    async (context) => {
      const runtime = await requireRuntime(context.req.raw)
      const agentId = context.req.param("agentId")
      const sessionId = context.req.param("sessionId")
      const storedId = runtime.resolveSessionId(agentId, sessionId)
      if (!storedId) return errorResponse("not_found", 404)
      await runtime.getSession(agentId, storedId)
      return context.json(
        SessionCommandsResponseSchema.parse(
          await runtime.slashCommands(agentId, sessionId)
        )
      )
    }
  )

  app.get(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId",
    async (context) => {
      const hermes = await requireRuntime(context.req.raw)
      const id = hermes.resolveSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      return context.json(
        await hermes.getSession(context.req.param("agentId"), id)
      )
    }
  )

  app.post("/api/aos/v1/agents/:agentId/sessions", async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const parsed = SessionCreateRequestSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!parsed.success) return errorResponse("invalid_request", 400)
    return context.json(
      await hermes.createSession(
        context.req.param("agentId"),
        parsed.data.title
      ),
      201
    )
  })

  app.patch(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId",
    async (context) => {
      const hermes = await requireRuntime(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const id = hermes.resolveSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      const parsed = SessionPatchRequestSchema.safeParse(
        await boundedJson(context.req.raw)
      )
      if (!parsed.success) return errorResponse("invalid_request", 400)
      await hermes.mutateSession(
        context.req.param("agentId"),
        id,
        "PATCH",
        parsed.data
      )
      return new Response(null, { status: 204 })
    }
  )

  app.delete(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId",
    async (context) => {
      const hermes = await requireRuntime(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const id = hermes.resolveSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      await hermes.mutateSession(context.req.param("agentId"), id, "DELETE")
      return new Response(null, { status: 204 })
    }
  )
}
