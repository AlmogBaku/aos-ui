import { randomUUID } from "node:crypto"
import { Hono } from "hono"

import { AttachmentStageRegistry } from "./core/attachment-stages"
import type { GuestInvitationService } from "./auth/guest-invitation"
import {
  ServerSessionNotFoundError,
  type RuntimeInstance,
  type ServerAttachmentStages,
  type ServerRuntime,
} from "./core/runtime"
import { redactForLog } from "./redaction"
import { registerContentRoutes } from "./routes/content"
import { registerInvitationRoutes } from "./routes/invitations"
import { errorResponse, type ErrorCode } from "./routes/http"
import { registerRuntimeRoute } from "./routes/runtime"

type Logger = {
  info(value: unknown): void
  error(value: unknown): void
}

export type ProxyAppOptions = {
  publicOrigin: string
  runtimeInstance: RuntimeInstance
  readiness?: () => Promise<"ready" | "not-ready">
  logger: Logger
  clock?: () => number
  guestInvitations?: {
    publicOrigin: string
    service: GuestInvitationService
  }
  /** Shared with the ACP socket so prompts can reference REST-staged batches. */
  attachmentStages?: ServerAttachmentStages
}

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const

export function createProxyApp(options: ProxyAppOptions) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  const clock = options.clock ?? Date.now
  const runtime = options.runtimeInstance.runtime
  const attachmentStages =
    options.attachmentStages ?? new AttachmentStageRegistry()

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

  const requireRuntime = async (request: Request) => {
    void request
    return runtime
  }
  const requireScopedSession = async (
    selected: ServerRuntime,
    agentId: string,
    publicSessionId: string
  ) => {
    const id = selected.resolveSessionId(agentId, publicSessionId)
    if (!id) throw new ServerSessionNotFoundError()
    await selected.getSession(agentId, id)
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
    const info = await runtime.runtimeInfo()
    const ready = info.status !== "unavailable"
    return context.json(
      {
        status: ready ? "ready" : "not-ready",
        timestamp: clock(),
        runtime: info.status,
      },
      ready ? 200 : 503
    )
  })

  registerRuntimeRoute(app, requireRuntime)
  registerContentRoutes(
    app,
    options,
    attachmentStages,
    requireRuntime,
    requireScopedSession
  )
  if (options.guestInvitations)
    registerInvitationRoutes(app, {
      publicOrigin: options.publicOrigin,
      guestPublicOrigin: options.guestInvitations.publicOrigin,
      invitations: options.guestInvitations.service,
      runtime,
    })

  app.onError((cause, context) => {
    const runtimeError = runtime.publicError(cause)
    const [code, status]: [ErrorCode, number] =
      cause instanceof ServerSessionNotFoundError
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
