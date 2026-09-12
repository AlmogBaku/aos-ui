import { randomUUID } from "node:crypto"
import type { AGUIEvent } from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"
import { Hono, type Context } from "hono"

import {
  ErrorResponseSchema,
  OperatorAuthStateSchema,
  RuntimeAuthStateSchema,
  RuntimeInfoSchema,
  RunStopResponseSchema,
  VisibilityUpdateRequestSchema,
  SessionCreateRequestSchema,
  SessionPatchRequestSchema,
  SessionActivityResponseSchema,
  SessionAttachmentStageRequestSchema,
  SessionAttachmentStageResponseSchema,
  SessionAudioResponseSchema,
  SessionContextResponseSchema,
  SessionInteractionSnapshotResponseSchema,
  SessionModelsResponseSchema,
  SessionModelSelectRequestSchema,
  SessionSpeechRequestSchema,
  SessionTodosResponseSchema,
  SessionTranscriptionRequestSchema,
  SessionTranscriptionResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
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
import { OidcAuthenticationError, type OidcCore } from "./auth/oidc"
import type { OperatorSession } from "./auth/session-cookie"
import { HermesBrowserAuthenticationError } from "./hermes-auth-broker"
import { HermesAuthenticationError } from "./hermes-transport"
import {
  HermesContentScopeError,
  HermesContentUnavailableError,
} from "./hermes-content"
import {
  HermesWorkspaceScopeError,
  HermesWorkspaceUnavailableError,
} from "./hermes-workspace"
import { HermesInteractionPublicError } from "./hermes-interactions"
import { HermesAttachmentStageRegistry } from "./hermes-stage-registry"

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
  hermes: HermesServerAdapter
  hermesForOperator?: (principalId: string) => HermesServerAdapter
  readiness?: () => Promise<"ready" | "not-ready">
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
  | "runtime_authentication_required"
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

function recordingBytes(dataUrl: string, mimeType: string) {
  const prefix = `data:${mimeType};base64,`
  if (!dataUrl.startsWith(prefix)) return undefined
  const encoded = dataUrl.slice(prefix.length)
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  )
    return undefined
  try {
    return Uint8Array.from(atob(encoded), (character) =>
      character.charCodeAt(0)
    )
  } catch {
    return undefined
  }
}

function runText(candidate: unknown) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return undefined
  const messages = (candidate as { messages?: unknown }).messages
  if (!Array.isArray(messages) || messages.length !== 1) return undefined
  const message = messages[0]
  if (
    !message ||
    typeof message !== "object" ||
    (message as { role?: unknown }).role !== "user"
  )
    return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  if (
    content.some(
      (part) =>
        !part ||
        typeof part !== "object" ||
        (part as { type?: unknown }).type !== "text" ||
        typeof (part as { text?: unknown }).text !== "string"
    )
  )
    return undefined
  return content.map((part) => (part as { text: string }).text).join("\n")
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

class RuntimeAuthenticationError extends Error {
  constructor() {
    super("Runtime authentication required")
    this.name = "RuntimeAuthenticationError"
  }
}

export function createProxyApp(options: ProxyAppOptions) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  const clock = options.clock ?? Date.now
  const activeRuns = new Map<string, HermesRunHandle>()
  const runAdmissions = new Set<string>()
  const attachmentStages = new HermesAttachmentStageRegistry()
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

  async function requireRuntime(request: Request) {
    const operator = await requireOperator(request)
    if (options.runtimeAuth) {
      const state = RuntimeAuthStateSchema.parse(
        await options.runtimeAuth.state({
          principalId: operator.operator.id,
          lane: "operator",
        })
      )
      if (state.status === "authentication-required")
        throw new RuntimeAuthenticationError()
      if (state.status === "unavailable") throw new HermesUnavailableError()
    }
    return options.hermesForOperator?.(operator.operator.id) ?? options.hermes
  }

  async function operatorSession(request: Request) {
    const session = await options.operatorAuth.session?.(request)
    if (!session) throw new OperatorAuthError()
    return session
  }

  function callbackUrl(requestUrl: string, path: string) {
    const incoming = new URL(requestUrl)
    return new URL(`${path}${incoming.search}`, options.publicOrigin)
  }

  function requestedReturnPath(requestUrl: string) {
    const url = new URL(requestUrl)
    const values = url.searchParams.getAll("return")
    if (values.length > 1) return undefined
    return values[0] ?? "/"
  }

  async function requireScopedSession(
    hermes: HermesServerAdapter,
    agentId: string,
    publicSessionId: string
  ) {
    const id = storedSessionId(agentId, publicSessionId)
    if (!id) throw new HermesSessionNotFoundError()
    await hermes.getSession(agentId, id)
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

  app.get("/api/aos/v1/auth/operator", async (context) =>
    context.json(
      OperatorAuthStateSchema.parse(
        await options.operatorAuth.state(context.req.raw)
      )
    )
  )

  app.get("/api/aos/v1/auth/operator/start", async (context) => {
    if (!options.operatorOidc) return errorResponse("not_found", 404)
    const returnPath = requestedReturnPath(context.req.url)
    if (returnPath === undefined) return errorResponse("invalid_request", 400)
    const started = await options.operatorOidc.begin(returnPath)
    return new Response(null, {
      status: 302,
      headers: {
        location: started.authorizationUrl.href,
        "set-cookie": started.flowCookie,
      },
    })
  })

  app.get("/api/aos/v1/auth/operator/callback", async (context) => {
    if (!options.operatorOidc) return errorResponse("not_found", 404)
    const completed = await options.operatorOidc.complete(
      callbackUrl(context.req.url, "/api/aos/v1/auth/operator/callback"),
      context.req.header("cookie") ?? null
    )
    const headers = new Headers({ "set-cookie": completed.flowCookie })
    if (completed.status === "rejected")
      return new Response(null, { status: 401, headers })
    headers.append("set-cookie", completed.sessionCookie)
    headers.set("location", completed.returnPath)
    return new Response(null, { status: 302, headers })
  })

  app.get("/api/aos/v1/auth/runtime", async (context) => {
    const operator = await requireOperator(context.req.raw)
    const state = options.runtimeAuth
      ? await options.runtimeAuth.state({
          principalId: operator.operator.id,
          lane: "operator",
        })
      : await options.hermes.authState()
    return context.json(RuntimeAuthStateSchema.parse(state))
  })

  app.get("/api/aos/v1/auth/runtime/start", async (context) => {
    if (!options.runtimeAuth?.begin) return errorResponse("not_found", 404)
    const returnPath = requestedReturnPath(context.req.url)
    if (returnPath === undefined) return errorResponse("invalid_request", 400)
    const session = await operatorSession(context.req.raw)
    const started = await options.runtimeAuth.begin({
      principalId: session.principalId,
      lane: "operator",
      browserSessionId: session.sessionId,
      callbackUrl: `${options.publicOrigin}/api/aos/v1/auth/runtime/upstream/auth/callback`,
      returnPath,
    })
    return started.status === "redirect"
      ? started.response
      : errorResponse("temporarily_unavailable", 503)
  })

  app.get(
    "/api/aos/v1/auth/runtime/upstream/auth/callback",
    async (context) => {
      if (!options.runtimeAuth?.complete) return errorResponse("not_found", 404)
      const session = await operatorSession(context.req.raw)
      const completed = await options.runtimeAuth.complete({
        principalId: session.principalId,
        lane: "operator",
        browserSessionId: session.sessionId,
        callbackUrl: callbackUrl(
          context.req.url,
          "/api/aos/v1/auth/runtime/upstream/auth/callback"
        ).href,
        returnPath: "/",
      })
      return new Response(null, {
        status: 302,
        headers: { location: completed.returnPath },
      })
    }
  )

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
      await hermes.updateAgentVisibility(
        context.req.param("agentId"),
        parsed.data.visibility,
        parsed.data.revision
      )
    )
  })

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
      const storedId = storedSessionId(
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
    "/api/aos/v1/agents/:agentId/sessions/:sessionId",
    async (context) => {
      const hermes = await requireRuntime(context.req.raw)
      const id = storedSessionId(
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
      const id = storedSessionId(
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
      const id = storedSessionId(
        context.req.param("agentId"),
        context.req.param("sessionId")
      )
      if (!id) return errorResponse("not_found", 404)
      await hermes.mutateSession(context.req.param("agentId"), id, "DELETE")
      return new Response(null, { status: 204 })
    }
  )

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

  app.get(`${sessionWorkspacePath}/todos`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionTodosResponseSchema.parse({
        todos: await hermes.todos(
          context.req.param("agentId"),
          context.req.param("sessionId")
        ),
      })
    )
  })

  app.get(`${sessionWorkspacePath}/activity`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionActivityResponseSchema.parse(
        await hermes.activity(
          context.req.param("agentId"),
          context.req.param("sessionId")
        )
      )
    )
  })

  const sessionContentPath = "/api/aos/v1/agents/:agentId/sessions/:sessionId"

  app.get(`${sessionContentPath}/interactions/pending`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    const runIds = new URL(context.req.url).searchParams.getAll("runId")
    if (
      runIds.length > 1 ||
      (runIds[0] !== undefined && !validIdentifier(runIds[0]))
    )
      return errorResponse("invalid_request", 400)
    const agentId = context.req.param("agentId")
    const sessionId = context.req.param("sessionId")
    await requireScopedSession(hermes, agentId, sessionId)
    return context.json(
      SessionInteractionSnapshotResponseSchema.parse(
        await hermes.pendingInteractions(agentId, sessionId, runIds[0])
      )
    )
  })

  app.post(`${sessionContentPath}/attachments/stage`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const body = SessionAttachmentStageRequestSchema.safeParse(
      await boundedJson(context.req.raw, 35_500_000)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    const agentId = context.req.param("agentId")
    const sessionId = context.req.param("sessionId")
    await requireScopedSession(hermes, agentId, sessionId)
    const stage = await hermes.stageAttachments(
      agentId,
      sessionId,
      body.data.attachments
    )
    const stageId = attachmentStages.create(agentId, sessionId, stage)
    if (!stageId) {
      await stage.cleanup().catch(() => undefined)
      return errorResponse("run_capacity_exceeded", 503)
    }
    return context.json(
      SessionAttachmentStageResponseSchema.parse({
        stageId,
        attachments: stage.public,
      }),
      201
    )
  })

  app.get(`${sessionContentPath}/artifacts/:artifactId`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    const artifact = await hermes.artifact(
      context.req.param("agentId"),
      context.req.param("sessionId"),
      context.req.param("artifactId")
    )
    return new Response(Uint8Array.from(artifact.bytes).buffer, {
      headers: {
        "content-type": artifact.mimeType ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      },
    })
  })

  app.get(`${sessionContentPath}/audio`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionAudioResponseSchema.parse(
        await hermes.audio(
          context.req.param("agentId"),
          context.req.param("sessionId")
        )
      )
    )
  })

  app.post(`${sessionContentPath}/audio/transcribe`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const body = SessionTranscriptionRequestSchema.safeParse(
      await boundedJson(context.req.raw, 7_500_000)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    const bytes = recordingBytes(body.data.dataUrl, body.data.mimeType)
    if (!bytes) return errorResponse("invalid_request", 400)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionTranscriptionResponseSchema.parse({
        transcript: await hermes.transcribe(
          context.req.param("agentId"),
          context.req.param("sessionId"),
          bytes,
          body.data.mimeType,
          context.req.raw.signal
        ),
      })
    )
  })

  app.post(`${sessionContentPath}/audio/speak`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const body = SessionSpeechRequestSchema.safeParse(
      await boundedJson(context.req.raw, 40_000)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    const speech = await hermes.speak(
      context.req.param("agentId"),
      context.req.param("sessionId"),
      body.data.text,
      context.req.raw.signal
    )
    return new Response(Uint8Array.from(speech.bytes).buffer, {
      headers: { "content-type": speech.mimeType },
    })
  })

  const runHandler = async (
    context: Context<{ Variables: { requestId: string } }>
  ) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const agentId = context.req.param("agentId")
    const threadId = context.req.param("sessionId")
    if (!agentId || !threadId) return errorResponse("not_found", 404)
    const sessionId = storedSessionId(agentId, threadId)
    if (!sessionId) return errorResponse("not_found", 404)
    const input = await boundedJson(context.req.raw, 1_100_000)
    if (input === undefined) return errorResponse("invalid_request", 400)
    const inputRecord =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined
    if (
      new URL(context.req.url).pathname.endsWith("/interactions/respond") &&
      (!inputRecord ||
        !Array.isArray(inputRecord.resume) ||
        inputRecord.resume.length === 0 ||
        !Array.isArray(inputRecord.messages) ||
        inputRecord.messages.length !== 0)
    )
      return errorResponse("invalid_request", 400)
    const forwarded = inputRecord?.forwardedProps
    const stageId =
      forwarded && typeof forwarded === "object" && !Array.isArray(forwarded)
        ? (forwarded as Record<string, unknown>).aosAttachmentStageId
        : undefined
    if (
      stageId !== undefined &&
      (typeof stageId !== "string" ||
        !validIdentifier(stageId) ||
        !forwarded ||
        Object.keys(forwarded).length !== 1)
    )
      return errorResponse("invalid_request", 400)
    const scope = { agentId, sessionId, threadId }
    const key = runKey(scope)
    if (activeRuns.has(key) || runAdmissions.has(key))
      return errorResponse("run_conflict", 409)
    if (activeRuns.size + runAdmissions.size >= maxActiveRuns)
      return errorResponse("run_capacity_exceeded", 503)
    runAdmissions.add(key)
    try {
      await hermes.getSession(agentId, sessionId)
    } catch (cause) {
      runAdmissions.delete(key)
      throw cause
    }
    const stage =
      typeof stageId === "string"
        ? attachmentStages.take(agentId, threadId, stageId)
        : undefined
    if (typeof stageId === "string" && !stage) {
      runAdmissions.delete(key)
      return errorResponse("invalid_request", 400)
    }
    let runInput = input
    if (stage && inputRecord) {
      const text = runText(input)
      const messages = inputRecord.messages
      if (text === undefined || !Array.isArray(messages)) {
        runAdmissions.delete(key)
        await stage.cleanup().catch(() => undefined)
        return errorResponse("invalid_request", 400)
      }
      runInput = {
        ...inputRecord,
        messages: [
          {
            ...(messages[0] as Record<string, unknown>),
            content: stage.appendTo(text),
          },
        ],
        forwardedProps: {},
      }
    }
    let handle: HermesRunHandle
    try {
      const runEngine = options.runEngine ?? new HermesRunEngine(hermes)
      handle = await runEngine.start(scope, runInput)
    } catch (cause) {
      await stage?.cleanup().catch(() => undefined)
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
    let state: "open" | "terminal" | "closed" | "cancelled" = "open"
    let readInFlight: Promise<IteratorResult<AGUIEvent>> | undefined
    let iteratorClose: Promise<void> | undefined
    const iterator = handle.events[Symbol.asyncIterator]()
    const disconnect = () => {
      if (detached) return
      detached = true
      handle.disconnect()
    }
    const removeAbortListener = () =>
      context.req.raw.signal.removeEventListener("abort", disconnect)
    const closeIterator = () => {
      if (iteratorClose) return iteratorClose
      iteratorClose = Promise.resolve(iterator.return?.()).then(
        () => undefined,
        () => undefined
      )
      return iteratorClose
    }
    context.req.raw.signal.addEventListener("abort", disconnect, {
      once: true,
    })
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (state !== "open" || readInFlight) return
        readInFlight = Promise.resolve(iterator.next())
        try {
          const result = await readInFlight
          if (state !== "open") return
          if (result.done) {
            state = "closed"
            removeAbortListener()
            controller.close()
            return
          }
          const event = result.value
          const terminal =
            event.type === "RUN_FINISHED" ||
            (event.type === "RUN_ERROR" &&
              event.code !== "AOS_SEND_UNCERTAIN" &&
              event.code !== "AOS_CONNECTION_INTERRUPTED")
          controller.enqueue(textEncoder.encode(encoder.encodeSSE(event)))
          if (terminal) {
            state = "terminal"
            removeAbortListener()
            if (activeRuns.get(key) === handle) activeRuns.delete(key)
            await closeIterator()
            if (state === "terminal") {
              state = "closed"
              controller.close()
            }
          }
        } catch {
          if (state === "open") {
            state = "closed"
            removeAbortListener()
            await closeIterator()
            controller.error(new Error("AOS run stream failed"))
          }
        } finally {
          readInFlight = undefined
        }
      },
      async cancel() {
        if (state === "closed" || state === "cancelled") return
        state = "cancelled"
        removeAbortListener()
        disconnect()
        const pendingRead = readInFlight
        await Promise.allSettled([
          closeIterator(),
          ...(pendingRead ? [pendingRead] : []),
        ])
      },
    })
    return new Response(stream, {
      headers: { "content-type": encoder.getContentType() },
    })
  }

  app.post("/api/aos/v1/agents/:agentId/sessions/:sessionId/runs", runHandler)
  app.post(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/interactions/respond",
    runHandler
  )

  app.post(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/runs/stop",
    async (context) => {
      await requireRuntime(context.req.raw)
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
        : cause instanceof OidcAuthenticationError
          ? cause.code === "temporarily-unavailable"
            ? ["temporarily_unavailable", 503]
            : ["invalid_request", 400]
          : cause instanceof HermesBrowserAuthenticationError
            ? cause.code === "provider-temporarily-unavailable"
              ? ["temporarily_unavailable", 503]
              : cause.code === "invalid-request"
                ? ["invalid_request", 400]
                : ["runtime_authentication_required", 401]
            : cause instanceof HermesAuthenticationError
              ? ["runtime_authentication_required", 401]
              : cause instanceof RuntimeAuthenticationError
                ? ["runtime_authentication_required", 401]
                : cause instanceof HermesAgentNotFoundError
                  ? ["not_found", 404]
                  : cause instanceof HermesRevisionConflictError
                    ? ["revision_conflict", 409]
                    : cause instanceof HermesSessionNotFoundError
                      ? ["not_found", 404]
                      : cause instanceof HermesSessionConflictError
                        ? ["revision_conflict", 409]
                        : cause instanceof HermesWorkspaceScopeError ||
                            cause instanceof HermesContentScopeError
                          ? ["not_found", 404]
                          : cause instanceof HermesWorkspaceUnavailableError ||
                              cause instanceof HermesContentUnavailableError ||
                              (cause instanceof HermesInteractionPublicError &&
                                (cause.code === "AOS_PROVIDER_UNAVAILABLE" ||
                                  cause.code === "AOS_RECONCILIATION_STALE")) ||
                              cause instanceof HermesUnavailableError
                            ? ["temporarily_unavailable", 503]
                            : cause instanceof HermesInteractionPublicError
                              ? cause.code === "AOS_INTERACTION_NOT_FOUND"
                                ? ["not_found", 404]
                                : ["invalid_request", 400]
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
