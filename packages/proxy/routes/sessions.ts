import {
  SessionCreateRequestSchema,
  SessionPatchRequestSchema,
  SESSION_CATALOG_MAX_WINDOW,
} from "../../protocol"
import type { ProxyAppOptions } from "../app"
import type { RuntimeInstance, ServerRuntime } from "../core/runtime"
import { boundedJson, errorResponse, pageQuery } from "./http"
import type { ProxyRouteApp } from "./types"

function sessionStatus(
  options: ProxyAppOptions,
  runtime: ServerRuntime,
  session: Awaited<ReturnType<ServerRuntime["getSession"]>>
) {
  const sessionId = runtime.resolveSessionId(session.agentId, session.id)
  if (!sessionId) return session
  const state = options.runtimeInstance.sessions.state({
    agentId: session.agentId,
    sessionId,
  })
  return {
    ...session,
    status:
      state === "waiting-for-input"
        ? ("waiting-for-input" as const)
        : state === "running" || state === "stopping"
          ? ("running" as const)
          : state === "uncertain"
            ? ("failed" as const)
            : session.status,
  }
}

export async function loadSessionHistory(
  runtimeInstance: RuntimeInstance,
  runtime: ServerRuntime,
  scope: { agentId: string; sessionId: string; threadId: string },
  page: { limit: number; offset: number }
) {
  const executionState = runtimeInstance.sessions.state(scope)
  if (executionState === "idle" || executionState === "waiting-for-input") {
    const session = await runtime.getSession(scope.agentId, scope.sessionId)
    if (executionState === "waiting-for-input" || session.status === "running")
      await runtimeInstance.sessions.discover(scope)
  }
  const history = await runtime.history(
    scope.agentId,
    scope.sessionId,
    page.limit,
    page.offset
  )
  const execution = runtimeInstance.sessions.snapshot(scope)
  if (execution.state === "waiting-for-input" && execution.interrupts.length) {
    const index = history.messages.findLastIndex(
      (message) => message.role === "assistant"
    )
    const message = history.messages[index]
    if (message?.role === "assistant")
      history.messages[index] = {
        ...message,
        status: { type: "requires-action", reason: "interrupt" },
        metadata: {
          custom: {
            ...message.metadata?.custom,
            agui: { interrupts: execution.interrupts },
          },
        },
      }
  }
  return {
    ...history,
    execution: {
      status:
        execution.state === "waiting-for-input"
          ? "waiting-for-input"
          : execution.state === "running" || execution.state === "stopping"
            ? "running"
            : execution.state === "uncertain"
              ? "failed"
              : "idle",
      ...(execution.state === "idle" ? {} : { runId: execution.runId }),
    },
  }
}

export function registerSessionRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  requireRuntime: (request: Request) => Promise<ServerRuntime>
) {
  app.get("/api/aos/v1/sessions", async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    const page = pageQuery(
      context.req.url,
      { limit: 50, offset: 0 },
      100,
      SESSION_CATALOG_MAX_WINDOW
    )
    if (!page) return errorResponse("invalid_request", 400)
    const result = await runtime.listAllSessions(page.limit, page.offset)
    return context.json({
      ...result,
      sessions: result.sessions.map((session) =>
        sessionStatus(options, runtime, session)
      ),
    })
  })

  app.get("/api/aos/v1/agents/:agentId/sessions", async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    const page = pageQuery(
      context.req.url,
      { limit: 50, offset: 0 },
      100,
      SESSION_CATALOG_MAX_WINDOW
    )
    if (!page) return errorResponse("invalid_request", 400)
    const result = await runtime.listSessions(
      context.req.param("agentId"),
      page.limit,
      page.offset
    )
    return context.json({
      ...result,
      sessions: result.sessions.map((session) =>
        sessionStatus(options, runtime, session)
      ),
    })
  })

  app.get(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/history",
    async (context) => {
      const runtime = await requireRuntime(context.req.raw)
      const storedId = runtime.resolveSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!storedId) return errorResponse("not_found", 404)
      const page = pageQuery(context.req.url, { limit: 200, offset: 0 }, 500)
      if (!page) return errorResponse("invalid_request", 400)
      const scope = {
        agentId: context.req.param("agentId"),
        sessionId: storedId,
        threadId: context.req.param("sessionId"),
      }
      return context.json(
        await loadSessionHistory(options.runtimeInstance, runtime, scope, page)
      )
    }
  )

  app.get(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId",
    async (context) => {
      const runtime = await requireRuntime(context.req.raw)
      const id = runtime.resolveSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      return context.json(
        sessionStatus(
          options,
          runtime,
          await runtime.getSession(context.req.param("agentId"), id)
        )
      )
    }
  )

  app.post("/api/aos/v1/agents/:agentId/sessions", async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const parsed = SessionCreateRequestSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!parsed.success) return errorResponse("invalid_request", 400)
    return context.json(
      await runtime.createSession(
        context.req.param("agentId"),
        parsed.data.title
      ),
      201
    )
  })

  app.patch(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId",
    async (context) => {
      const runtime = await requireRuntime(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const id = runtime.resolveSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      const parsed = SessionPatchRequestSchema.safeParse(
        await boundedJson(context.req.raw)
      )
      if (!parsed.success) return errorResponse("invalid_request", 400)
      await runtime.mutateSession(
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
      const runtime = await requireRuntime(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const id = runtime.resolveSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      await runtime.mutateSession(context.req.param("agentId"), id, "DELETE")
      return new Response(null, { status: 204 })
    }
  )
}
