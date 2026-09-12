import { randomUUID } from "node:crypto"
import { EventEncoder } from "@ag-ui/encoder"
import { Hono } from "hono"

import {
  ErrorResponseSchema,
  HermesAuthStateSchema,
  OperatorAuthStateSchema,
  RuntimeInfoSchema,
  RunStopResponseSchema,
  VisibilityUpdateRequestSchema,
  SessionCreateRequestSchema,
  SessionPatchRequestSchema,
  SESSION_CATALOG_MAX_WINDOW,
} from "../protocol"
import {
  HermesAgentNotFoundError,
  HermesRevisionConflictError,
  HermesServerAdapter,
  HermesSessionConflictError,
  HermesSessionNotFoundError,
  HermesUnavailableError,
} from "./hermes-adapter"
import { OperatorAuthError, type OperatorAuthenticator } from "./operator-auth"
import { redactForLog } from "./redaction"
import {
  HermesRunEngine,
  HermesRunPublicError,
  type HermesRunHandle,
  type HermesRunScope,
} from "./hermes-run"

type Logger = {
  info(value: unknown): void
  error(value: unknown): void
}

export type ProxyAppOptions = {
  publicOrigin: string
  operatorAuth: OperatorAuthenticator
  hermes: HermesServerAdapter
  runEngine?: HermesRunEngine
  maxActiveRuns?: number
  logger: Logger
  clock?: () => number
}

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const

type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "revision_conflict"
  | "run_conflict"
  | "run_capacity_exceeded"
  | "temporarily_unavailable"
  | "internal_error"

function errorResponse(code: ErrorCode, status: number) {
  return new Response(
    JSON.stringify(ErrorResponseSchema.parse({ error: { code } })),
    {
      status,
      headers: { "content-type": "application/json; charset=UTF-8" },
    }
  )
}

function storedSessionId(agentId: string, sessionId: string) {
  if (!validIdentifier(agentId) || sessionId.length > 1_024) return undefined
  const match = /^hermes:([^:]+):(.+)$/u.exec(sessionId)
  if (!match) return undefined
  try {
    const owner = decodeURIComponent(match[1])
    const storedId = decodeURIComponent(match[2])
    return owner === agentId && validIdentifier(storedId) ? storedId : undefined
  } catch {
    return undefined
  }
}

function validIdentifier(value: string) {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function isRunConflict(error: unknown) {
  return (
    error instanceof Error &&
    error.message === "An AOS run is already active for this Session"
  )
}

function pageQuery(
  requestUrl: string,
  defaults: { limit: number; offset: number },
  maxLimit: number,
  maxWindow?: number
) {
  const url = new URL(requestUrl)
  if (url.search.length > 2_048) return undefined
  if (
    [...url.searchParams.keys()].some(
      (key) => key !== "limit" && key !== "offset"
    )
  )
    return undefined
  const limitValues = url.searchParams.getAll("limit")
  const offsetValues = url.searchParams.getAll("offset")
  if (limitValues.length > 1 || offsetValues.length > 1) return undefined
  const integer = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  const limit = integer(limitValues[0], defaults.limit)
  const offset = integer(offsetValues[0], defaults.offset)
  if (
    limit === undefined ||
    offset === undefined ||
    limit < 1 ||
    limit > maxLimit ||
    offset < 0 ||
    (maxWindow !== undefined && offset + limit > maxWindow)
  )
    return undefined
  return { limit, offset }
}

async function boundedJson(request: Request, maxBytes = 16 * 1024) {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  )
    return undefined
  const rawLength = request.headers.get("content-length")
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) return undefined
    const contentLength = Number(rawLength)
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes)
      return undefined
  }
  try {
    const text = await request.text()
    if (!text || new TextEncoder().encode(text).byteLength > maxBytes)
      return undefined
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function createProxyApp(options: ProxyAppOptions) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  const clock = options.clock ?? Date.now
  const runEngine = options.runEngine ?? new HermesRunEngine(options.hermes)
  const activeRuns = new Map<string, HermesRunHandle>()
  const runAdmissions = new Set<string>()
  const maxActiveRuns = options.maxActiveRuns ?? 256
  if (
    !Number.isSafeInteger(maxActiveRuns) ||
    maxActiveRuns < 1 ||
    maxActiveRuns > 4_096
  )
    throw new Error("Invalid active run limit")

  const runKey = (scope: Pick<HermesRunScope, "agentId" | "sessionId">) =>
    `${scope.agentId}\u0000${scope.sessionId}`

  app.use("*", async (context, next) => {
    const requestId = randomUUID()
    context.set("requestId", requestId)
    const startedAt = clock()
    await next()
    for (const [name, value] of Object.entries(securityHeaders))
      context.header(name, value)
    context.header("x-request-id", requestId)
    options.logger.info(
      redactForLog({
        event: "request.completed",
        requestId,
        method: context.req.method,
        status: context.res.status,
        durationMs: Math.max(0, clock() - startedAt),
      })
    )
  })

  async function requireOperator(request: Request) {
    return options.operatorAuth.require(request)
  }

  app.get("/api/aos/v1/healthz", (context) =>
    context.json({ status: "live", timestamp: clock() })
  )

  app.get("/api/aos/v1/readyz", async (context) => {
    const info = await options.hermes.runtimeInfo()
    return context.json(
      {
        status: info.status === "unavailable" ? "not-ready" : "ready",
        timestamp: clock(),
        runtime: info.status,
      },
      info.status === "unavailable" ? 503 : 200
    )
  })

  app.get("/api/aos/v1/auth/operator", async (context) =>
    context.json(
      OperatorAuthStateSchema.parse(
        await options.operatorAuth.state(context.req.raw)
      )
    )
  )

  app.get("/api/aos/v1/auth/hermes", async (context) => {
    await requireOperator(context.req.raw)
    return context.json(
      HermesAuthStateSchema.parse(await options.hermes.authState())
    )
  })

  app.get("/api/aos/v1/runtime", async (context) => {
    await requireOperator(context.req.raw)
    return context.json(
      RuntimeInfoSchema.parse(await options.hermes.runtimeInfo())
    )
  })

  app.get("/api/aos/v1/agents", async (context) => {
    await requireOperator(context.req.raw)
    return context.json(await options.hermes.listAgents())
  })

  app.patch("/api/aos/v1/agents/:agentId/visibility", async (context) => {
    await requireOperator(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const contentType = context.req.header("content-type")?.split(";", 1)[0]
    if (contentType !== "application/json")
      return errorResponse("invalid_request", 400)
    const contentLength = Number(context.req.header("content-length") ?? "0")
    if (Number.isFinite(contentLength) && contentLength > 16 * 1024)
      return errorResponse("invalid_request", 400)
    let payload: unknown
    try {
      const text = await context.req.text()
      if (text.length > 16 * 1024) return errorResponse("invalid_request", 400)
      payload = JSON.parse(text) as unknown
    } catch {
      return errorResponse("invalid_request", 400)
    }
    const parsed = VisibilityUpdateRequestSchema.safeParse(payload)
    if (!parsed.success) return errorResponse("invalid_request", 400)
    return context.json(
      await options.hermes.updateAgentVisibility(
        context.req.param("agentId"),
        parsed.data.visibility,
        parsed.data.revision
      )
    )
  })

  app.get("/api/aos/v1/sessions", async (context) => {
    await requireOperator(context.req.raw)
    const page = pageQuery(
      context.req.url,
      { limit: 50, offset: 0 },
      100,
      SESSION_CATALOG_MAX_WINDOW
    )
    if (!page) return errorResponse("invalid_request", 400)
    return context.json(
      await options.hermes.listAllSessions(page.limit, page.offset)
    )
  })

  app.get("/api/aos/v1/agents/:agentId/sessions", async (context) => {
    await requireOperator(context.req.raw)
    const page = pageQuery(
      context.req.url,
      { limit: 50, offset: 0 },
      100,
      SESSION_CATALOG_MAX_WINDOW
    )
    if (!page) return errorResponse("invalid_request", 400)
    return context.json(
      await options.hermes.listSessions(
        context.req.param("agentId"),
        page.limit,
        page.offset
      )
    )
  })

  app.get(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/history",
    async (context) => {
      await requireOperator(context.req.raw)
      const storedId = storedSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!storedId) return errorResponse("not_found", 404)
      const page = pageQuery(context.req.url, { limit: 200, offset: 0 }, 500)
      if (!page) return errorResponse("invalid_request", 400)
      return context.json(
        await options.hermes.history(
          context.req.param("agentId"),
          storedId,
          page.limit,
          page.offset
        )
      )
    }
  )
  app.get(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId",
    async (context) => {
      await requireOperator(context.req.raw)
      const id = storedSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      return context.json(
        await options.hermes.getSession(context.req.param("agentId"), id)
      )
    }
  )
  app.post("/api/aos/v1/agents/:agentId/sessions", async (context) => {
    await requireOperator(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const parsed = SessionCreateRequestSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!parsed.success) return errorResponse("invalid_request", 400)
    return context.json(
      await options.hermes.createSession(
        context.req.param("agentId"),
        parsed.data.title
      ),
      201
    )
  })
  app.patch(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId",
    async (context) => {
      await requireOperator(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const id = storedSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      const parsed = SessionPatchRequestSchema.safeParse(
        await boundedJson(context.req.raw)
      )
      if (!parsed.success) return errorResponse("invalid_request", 400)
      await options.hermes.mutateSession(
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
      await requireOperator(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const id = storedSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      await options.hermes.mutateSession(
        context.req.param("agentId"),
        id,
        "DELETE"
      )
      return new Response(null, { status: 204 })
    }
  )

  app.post(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/runs",
    async (context) => {
      await requireOperator(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const agentId = context.req.param("agentId")
      const threadId = context.req.param("sessionId")
      const sessionId = storedSessionId(agentId, threadId)
      if (!sessionId) return errorResponse("not_found", 404)
      const input = await boundedJson(context.req.raw, 1_100_000)
      if (input === undefined) return errorResponse("invalid_request", 400)
      const scope = { agentId, sessionId, threadId }
      const key = runKey(scope)
      if (activeRuns.has(key) || runAdmissions.has(key))
        return errorResponse("run_conflict", 409)
      if (activeRuns.size + runAdmissions.size >= maxActiveRuns)
        return errorResponse("run_capacity_exceeded", 503)
      runAdmissions.add(key)
      try {
        await options.hermes.getSession(agentId, sessionId)
      } catch (cause) {
        runAdmissions.delete(key)
        throw cause
      }
      let handle: HermesRunHandle
      try {
        handle = await runEngine.start(scope, input)
      } catch (cause) {
        options.logger.error(
          redactForLog({
            event: "run.start.failed",
            requestId: context.get("requestId"),
            error: cause,
          })
        )
        return isRunConflict(cause)
          ? errorResponse("run_conflict", 409)
          : cause instanceof HermesRunPublicError
            ? errorResponse("temporarily_unavailable", 503)
            : errorResponse("invalid_request", 400)
      } finally {
        runAdmissions.delete(key)
      }
      activeRuns.set(key, handle)
      const encoder = new EventEncoder({ accept: "text/event-stream" })
      const textEncoder = new TextEncoder()
      let detached = false
      let cancelled = false
      const disconnect = () => {
        if (detached) return
        detached = true
        handle.disconnect()
      }
      context.req.raw.signal.addEventListener("abort", disconnect, {
        once: true,
      })
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let terminal = false
          try {
            for await (const event of handle.events) {
              if (cancelled) break
              terminal =
                event.type === "RUN_FINISHED" ||
                (event.type === "RUN_ERROR" &&
                  event.code !== "AOS_SEND_UNCERTAIN" &&
                  event.code !== "AOS_CONNECTION_INTERRUPTED")
              if (!cancelled)
                controller.enqueue(textEncoder.encode(encoder.encodeSSE(event)))
            }
          } finally {
            context.req.raw.signal.removeEventListener("abort", disconnect)
            if (terminal && activeRuns.get(key) === handle)
              activeRuns.delete(key)
            if (!cancelled) controller.close()
          }
        },
        cancel() {
          cancelled = true
          context.req.raw.signal.removeEventListener("abort", disconnect)
          disconnect()
        },
      })
      return new Response(stream, {
        headers: { "content-type": encoder.getContentType() },
      })
    }
  )

  app.post(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/runs/stop",
    async (context) => {
      await requireOperator(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const agentId = context.req.param("agentId")
      const sessionId = storedSessionId(agentId, context.req.param("sessionId"))
      if (!sessionId) return errorResponse("not_found", 404)
      const key = runKey({ agentId, sessionId })
      const handle = activeRuns.get(key)
      if (!handle) return errorResponse("not_found", 404)
      let status: "stopping" | "idle"
      try {
        status = await handle.stop()
      } catch {
        return errorResponse("temporarily_unavailable", 503)
      }
      if (status === "idle" && activeRuns.get(key) === handle)
        activeRuns.delete(key)
      return new Response(
        JSON.stringify(RunStopResponseSchema.parse({ status })),
        {
          status: status === "stopping" ? 202 : 200,
          headers: { "content-type": "application/json; charset=UTF-8" },
        }
      )
    }
  )

  app.onError((cause, context) => {
    const [code, status]: [ErrorCode, number] =
      cause instanceof OperatorAuthError
        ? ["unauthenticated", 401]
        : cause instanceof HermesAgentNotFoundError
          ? ["not_found", 404]
          : cause instanceof HermesRevisionConflictError
            ? ["revision_conflict", 409]
            : cause instanceof HermesSessionNotFoundError
              ? ["not_found", 404]
              : cause instanceof HermesSessionConflictError
                ? ["revision_conflict", 409]
                : cause instanceof HermesUnavailableError
                  ? ["temporarily_unavailable", 503]
                  : ["internal_error", 500]
    options.logger.error(
      redactForLog({
        event: "request.failed",
        requestId: context.get("requestId"),
        code,
        error: cause,
      })
    )
    return errorResponse(code, status)
  })

  app.notFound(() => errorResponse("not_found", 404))
  return app
}
