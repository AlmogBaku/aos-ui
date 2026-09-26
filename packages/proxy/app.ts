import { randomUUID } from "node:crypto"
import { Hono } from "hono"

import type { Logger } from "../lifecycle"
import { AttachmentStageRegistry } from "./core/attachment-stages"
import type { GuestInvitationService } from "./auth/guest-invitation"
import { OPERATOR_PRINCIPAL } from "./core/principal"
import { coreFailure, type PublicFailure } from "./core/failures"
import type { LinkState } from "./core/link"
import {
  ServerSessionNotFoundError,
  type RuntimeInstance,
  type ServerAttachmentStages,
  type ServerRuntime,
} from "./core/runtime"
import type { SessionCoordinator } from "./core/session-coordinator"
import type { PushRegistrations } from "./push/registrations"
import { registerContentRoutes } from "./routes/content"
import { registerInvitationRoutes } from "./routes/invitations"
import { registerMcpAppRoutes } from "./routes/mcp-apps"
import { errorResponse, type ErrorCode } from "./routes/http"
import { registerPushRoutes } from "./routes/push"
import { registerRuntimeRoute } from "./routes/runtime"

/** The HTTP answer each kind of public failure travels as. */
const FAILURE_RESPONSES: Readonly<
  Record<PublicFailure["kind"], readonly [ErrorCode, number]>
> = {
  gone: ["not_found", 404],
  unavailable: ["temporarily_unavailable", 503],
  uncertain: ["uncertain_mutation", 503],
  invalid_request: ["invalid_request", 400],
  revision_conflict: ["revision_conflict", 409],
  runtime_authentication_required: ["runtime_authentication_required", 401],
}

/**
 * What liveness reports, read afresh on every request: each native link's
 * state, and the gauges a leak would show in.
 */
export type HealthReading = {
  links: readonly { name: string; state: LinkState }[]
  gauges: { sockets: number; memberships: number } & ReturnType<
    SessionCoordinator["gauges"]
  >
}

export type ProxyAppOptions = {
  publicOrigin: string
  runtimeInstance: RuntimeInstance
  readiness?: () => Promise<"ready" | "not-ready">
  health: () => HealthReading
  logger: Logger
  clock?: () => number
  guestInvitations?: {
    publicOrigin: string
    service: GuestInvitationService
  }
  /** Shared with the ACP socket so prompts can reference REST-staged batches. */
  attachmentStages?: ServerAttachmentStages
  /** Absent means this deployment configured no Web Push. */
  push?: {
    /** Derived from the private key; the browser subscribes with it. */
    publicKey: string
    registrations: PushRegistrations
  }
}

/**
 * Which principal a trusted operator request belongs to. The operator surface is
 * single-tenant, so every request is the one operator principal: this is the one
 * seam a deployment with several operators would resolve an identity at.
 */
function resolvePrincipal(request: Request) {
  void request
  return OPERATOR_PRINCIPAL
}

/**
 * The route a logged request addressed. The query string is deliberately
 * dropped: it can carry a token or an invitation ref, and the path alone is
 * what an operator correlates a status or a failure code with.
 */
function requestPath(url: string) {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
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
      {
        requestId,
        method: context.req.method,
        path: requestPath(context.req.url),
        status: context.res.status,
        durationMs: Math.max(0, clock() - startedAt),
      },
      "request.completed"
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
    const providerSessionId = selected.resolveProviderSessionId(
      agentId,
      publicSessionId
    )
    if (!providerSessionId) throw new ServerSessionNotFoundError()
    await selected.getSession(agentId, providerSessionId)
    return providerSessionId
  }

  // A native link down degrades the process but answers 200 all the same: the
  // container is not restarted for an upstream outage.
  app.get("/api/aos/v1/healthz", (context) => {
    const { links, gauges } = options.health()
    return context.json({
      status: links.every(({ state }) => state === "ready") ? "ok" : "degraded",
      links,
      gauges,
    })
  })
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
  registerMcpAppRoutes(app, options, requireRuntime, requireScopedSession)
  registerPushRoutes(app, options, resolvePrincipal)
  if (options.guestInvitations)
    registerInvitationRoutes(app, {
      guestPublicOrigin: options.guestInvitations.publicOrigin,
      invitations: options.guestInvitations.service,
      runtime,
    })

  app.onError((cause, context) => {
    const failure = coreFailure(cause) ?? runtime.publicError(cause)
    const [code, status] = failure
      ? FAILURE_RESPONSES[failure.kind]
      : (["internal_error", 500] as const)
    options.logger.error(
      {
        requestId: context.get("requestId"),
        path: requestPath(context.req.url),
        code,
        err: cause,
      },
      "request.failed"
    )
    return errorResponse(code, status)
  })

  app.notFound(() => errorResponse("not_found", 404))
  return app
}
