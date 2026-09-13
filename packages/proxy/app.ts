import { randomUUID } from "node:crypto"
import { Hono } from "hono"

import { RuntimeAuthStateSchema } from "../protocol"
import { HermesAttachmentStageRegistry } from "./runtimes/hermes/stage-registry"
import type { GuestInvitationService } from "./auth/guest-invitation"
import { OidcAuthenticationError, type OidcCore } from "./auth/oidc"
import type { OperatorSession } from "./auth/session-cookie"
import { OperatorAuthError, type OperatorAuthenticator } from "./operator-auth"
import { redactForLog } from "./redaction"
import type { ServerRunEngine, ServerRunHandle, ServerRuntime } from "./runtime"
import { ServerSessionNotFoundError } from "./runtime"
import { registerAuthRoutes } from "./routes/auth"
import { registerContentRoutes } from "./routes/content"
import { errorResponse, type ErrorCode } from "./routes/http"
import { registerRunRoutes } from "./routes/runs"
import { registerSessionRoutes } from "./routes/sessions"
import { registerWorkspaceRoutes } from "./routes/workspace"

type Logger = {
  info(value: unknown): void
  error(value: unknown): void
}

export type ProxyAppOptions = {
  publicOrigin: string
  operatorAuth: OperatorAuthenticator & {
    session?(request: Request): Promise<OperatorSession | undefined>
  }
  operatorOidc?: OidcCore<OperatorSession>
  guestInvitations?: GuestInvitationService
  runtimeAuth?: {
    state(scope: {
      principalId: string
      lane: "operator"
    }): Promise<unknown> | unknown
    begin?(binding: {
      principalId: string
      lane: "operator"
      browserSessionId: string
      callbackUrl: string
      returnPath: string
    }): Promise<
      | { status: "redirect"; response: Response }
      | { status: "unavailable"; reason: string }
    >
    complete?(binding: {
      principalId: string
      lane: "operator"
      browserSessionId: string
      callbackUrl: string
      returnPath: string
    }): Promise<{ status: "authenticated"; returnPath: string }>
  }
  hermes: ServerRuntime
  hermesForOperator?: (principalId: string) => ServerRuntime
  readiness?: () => Promise<"ready" | "not-ready">
  runEngine?: ServerRunEngine
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

class RuntimeAuthenticationError extends Error {
  constructor() {
    super("Runtime authentication required")
    this.name = "RuntimeAuthenticationError"
  }
}

class RuntimeUnavailableError extends Error {
  constructor() {
    super("Runtime unavailable")
    this.name = "RuntimeUnavailableError"
  }
}

export function createProxyApp(options: ProxyAppOptions) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  const clock = options.clock ?? Date.now
  const activeRuns = new Map<
    string,
    {
      handle: ServerRunHandle
      runId: string
      engine: ServerRunEngine
      principalId: string
    }
  >()
  const runAdmissions = new Set<string>()
  const attachmentStages = new HermesAttachmentStageRegistry()
  const maxActiveRuns = options.maxActiveRuns ?? 256
  if (
    !Number.isSafeInteger(maxActiveRuns) ||
    maxActiveRuns < 1 ||
    maxActiveRuns > 4_096
  )
    throw new Error("Invalid active run limit")

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

  const requireRuntimeBinding = async (request: Request) => {
    const operator = await options.operatorAuth.require(request)
    if (options.runtimeAuth) {
      const state = RuntimeAuthStateSchema.parse(
        await options.runtimeAuth.state({
          principalId: operator.operator.id,
          lane: "operator",
        })
      )
      if (state.status === "authentication-required")
        throw new RuntimeAuthenticationError()
      if (state.status === "unavailable") throw new RuntimeUnavailableError()
    }
    return {
      runtime:
        options.hermesForOperator?.(operator.operator.id) ?? options.hermes,
      principalId: operator.operator.id,
    }
  }
  const requireRuntime = async (request: Request) =>
    (await requireRuntimeBinding(request)).runtime

  const requireScopedSession = async (
    runtime: ServerRuntime,
    agentId: string,
    publicSessionId: string
  ) => {
    const id = runtime.resolveSessionId(agentId, publicSessionId)
    if (!id) throw new ServerSessionNotFoundError()
    await runtime.getSession(agentId, id)
    return id
  }

  app.get("/api/aos/v1/healthz", (context) =>
    context.json({ status: "live", timestamp: clock() })
  )
  app.get("/api/aos/v1/readyz", async (context) => {
    if (options.readiness) {
      const status = await options.readiness()
      return context.json(
        { status, timestamp: clock(), runtime: status },
        status === "ready" ? 200 : 503
      )
    }
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

  registerAuthRoutes(app, options)
  registerSessionRoutes(app, options, requireRuntime)
  registerWorkspaceRoutes(app, options, requireRuntime, requireScopedSession)
  registerContentRoutes(
    app,
    options,
    attachmentStages,
    requireRuntime,
    requireScopedSession
  )
  registerRunRoutes(
    app,
    options,
    activeRuns,
    runAdmissions,
    attachmentStages,
    maxActiveRuns,
    requireRuntimeBinding
  )

  app.onError((cause, context) => {
    const runtimeError = options.hermes.publicError(cause)
    const [code, status]: [ErrorCode, number] =
      cause instanceof OperatorAuthError
        ? ["unauthenticated", 401]
        : cause instanceof OidcAuthenticationError
          ? cause.code === "temporarily-unavailable"
            ? ["temporarily_unavailable", 503]
            : ["invalid_request", 400]
          : cause instanceof RuntimeAuthenticationError
            ? ["runtime_authentication_required", 401]
            : cause instanceof RuntimeUnavailableError
              ? ["temporarily_unavailable", 503]
              : cause instanceof ServerSessionNotFoundError
                ? ["not_found", 404]
                : runtimeError
                  ? [runtimeError.code, runtimeError.status]
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
