import { randomUUID } from "node:crypto"
import { Hono } from "hono"

import {
  ErrorResponseSchema,
  HermesAuthStateSchema,
  OperatorAuthStateSchema,
  RuntimeInfoSchema,
  VisibilityUpdateRequestSchema,
} from "../protocol"
import {
  HermesAgentNotFoundError,
  HermesRevisionConflictError,
  HermesServerAdapter,
  HermesUnavailableError,
} from "./hermes-adapter"
import { OperatorAuthError, type OperatorAuthenticator } from "./operator-auth"
import { redactForLog } from "./redaction"

type Logger = {
  info(value: unknown): void
  error(value: unknown): void
}

export type ProxyAppOptions = {
  publicOrigin: string
  operatorAuth: OperatorAuthenticator
  hermes: HermesServerAdapter
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

export function createProxyApp(options: ProxyAppOptions) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  const clock = options.clock ?? Date.now

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

  app.onError((cause, context) => {
    const [code, status]: [ErrorCode, number] =
      cause instanceof OperatorAuthError
        ? ["unauthenticated", 401]
        : cause instanceof HermesAgentNotFoundError
          ? ["not_found", 404]
          : cause instanceof HermesRevisionConflictError
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
