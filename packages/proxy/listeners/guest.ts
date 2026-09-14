import { RunAgentInputSchema } from "@ag-ui/core"
import { Hono } from "hono"

import { SessionHistoryResponseSchema } from "../../protocol"
import type {
  GuestInvitationService,
  GuestOperation,
} from "../auth/guest-invitation"
import {
  createGuestRunAccess,
  projectGuestError,
  projectGuestHistory,
} from "../auth/guest-runtime-projection"
import {
  createGuestRequestAuthorizer,
  guestBearerToken,
  guestControllerId,
  sameGuestBinding,
} from "../auth/guest-request"
import {
  projectGuestOutbound,
  type GuestPublicErrorCode,
} from "../auth/guest-projection"
import type { RuntimeInstance } from "../core/runtime"
import { ServerRunConflictError } from "../core/runtime"
import type { ReconnectCursorCodec } from "../events/cursor"
import {
  createGuestEventService,
  GUEST_EVENTS_COOKIE,
  guestEventTarget,
} from "../events/guest"
import { boundedJson, validIdentifier } from "../routes/http"
import { loadSessionArtifact } from "../routes/content"
import { createRunStreamResponse, normalizeRunInput } from "../routes/runs"
import { loadSessionHistory } from "../routes/sessions"

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const

const GUEST_EVENTS_CREDENTIAL_SECONDS = 60

export type GuestListenerServiceOptions = {
  publicOrigin: string
  deploymentId: string
  bootEpoch: string
  runtime: RuntimeInstance
  invitations: GuestInvitationService
  cursor: ReconnectCursorCodec
  maxEventPeers?: number
  maxEventPeersPerInvitation?: number
  maxEventStreamsPerPeer?: number
  now?: () => number
  schedule?: (delayMs: number, task: () => void) => unknown
  cancel?: (timer: unknown) => void
}

function pageQuery(requestUrl: string) {
  const url = new URL(requestUrl)
  if (
    url.search.length > 2_048 ||
    [...url.searchParams.keys()].some(
      (key) => key !== "limit" && key !== "offset"
    ) ||
    url.searchParams.getAll("limit").length > 1 ||
    url.searchParams.getAll("offset").length > 1
  )
    return undefined
  const integer = (name: "limit" | "offset", fallback: number) => {
    const value = url.searchParams.get(name)
    if (value === null) return fallback
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  const limit = integer("limit", 200)
  const offset = integer("offset", 0)
  return limit !== undefined &&
    offset !== undefined &&
    limit >= 1 &&
    limit <= 500
    ? { limit, offset }
    : undefined
}

function emptyError(status: number) {
  return new Response(null, { status })
}

async function projectedErrorResponse(
  authorize: ReturnType<typeof createGuestRequestAuthorizer>["authorize"],
  request: Request,
  agentId: string,
  sessionId: string,
  code: GuestPublicErrorCode,
  retryable: boolean,
  status: number
) {
  const authorization = await authorize(request, {
    agentId,
    sessionId,
    operation: "errors:read",
  })
  return authorization
    ? projectGuestError(authorization, code, retryable, status)
    : emptyError(status)
}

function encodedFilename(filename: string) {
  return encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function createGuestListenerService(
  options: GuestListenerServiceOptions
) {
  const app = new Hono()
  const now = options.now ?? Date.now
  const authorizer = createGuestRequestAuthorizer({
    runtimeId: options.runtime.id,
    invitations: options.invitations,
    now,
  })
  const schedule =
    options.schedule ??
    ((delayMs: number, task: () => void) => setTimeout(task, delayMs))
  const cancel =
    options.cancel ?? ((timer: unknown) => clearTimeout(timer as number))
  const events = createGuestEventService(options)
  let subscriberSequence = 0

  app.use("*", async (context, next) => {
    await next()
    for (const [name, value] of Object.entries(securityHeaders))
      context.header(name, value)
  })

  app.post("/api/guest/v1/events/authorize", async (context) => {
    if (context.req.header("origin") !== options.publicOrigin)
      return emptyError(403)
    const target = guestEventTarget(
      context.req.raw,
      "/api/guest/v1/events/authorize"
    )
    if (!target) return emptyError(404)
    const authorization = await authorizer.authorize(context.req.raw, {
      ...target,
      operation: "messages:read",
    })
    if (!authorization) return emptyError(401)
    const storedSessionId = options.runtime.runtime.resolveSessionId(
      target.agentId,
      target.sessionId
    )
    if (!storedSessionId) return emptyError(404)
    try {
      await options.runtime.runtime.getSession(target.agentId, storedSessionId)
      const token = guestBearerToken(context.req.raw)
      const remainingSeconds = Math.min(
        GUEST_EVENTS_CREDENTIAL_SECONDS,
        Math.floor(
          (authorization.authorizationExpiresAt * 1_000 - now()) / 1_000
        )
      )
      if (!token || remainingSeconds <= 0) return emptyError(401)
      return new Response(null, {
        status: 204,
        headers: {
          "set-cookie": `${GUEST_EVENTS_COOKIE}=${token}; Path=/; Max-Age=${remainingSeconds}; Secure; HttpOnly; SameSite=Strict`,
        },
      })
    } catch {
      return emptyError(503)
    }
  })

  app.get(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/history",
    async (context) => {
      const agentId = context.req.param("agentId")
      const sessionId = context.req.param("sessionId")
      const authorization = await authorizer.authorize(context.req.raw, {
        agentId,
        sessionId,
        operation: "messages:read",
      })
      if (!authorization) return emptyError(401)
      const storedSessionId = options.runtime.runtime.resolveSessionId(
        agentId,
        sessionId
      )
      const page = pageQuery(context.req.url)
      if (!storedSessionId || !page)
        return emptyError(storedSessionId ? 400 : 404)
      try {
        const history = SessionHistoryResponseSchema.parse(
          await loadSessionHistory(
            options.runtime,
            options.runtime.runtime,
            { agentId, sessionId: storedSessionId, threadId: sessionId },
            page
          )
        )
        return context.json(projectGuestHistory(history, authorization))
      } catch {
        return projectedErrorResponse(
          authorizer.authorize,
          context.req.raw,
          agentId,
          sessionId,
          "temporarily_unavailable",
          true,
          503
        )
      }
    }
  )

  app.get(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId",
    async (context) => {
      const agentId = context.req.param("agentId")
      const sessionId = context.req.param("sessionId")
      const authorization = await authorizer.authorize(context.req.raw, {
        agentId,
        sessionId,
        operation: "artifacts:read",
      })
      if (!authorization) return emptyError(401)
      const storedSessionId = options.runtime.runtime.resolveSessionId(
        agentId,
        sessionId
      )
      if (!storedSessionId) return emptyError(404)
      try {
        const artifact = await loadSessionArtifact(
          options.runtime.runtime,
          agentId,
          sessionId,
          context.req.param("artifactId")
        )
        if (!artifact) return emptyError(404)
        const projected = projectGuestOutbound(
          {
            transport: "artifact",
            agentId,
            sessionId,
            payload: {
              type: "artifact",
              name: artifact.filename,
              mediaType: artifact.mimeType ?? "application/octet-stream",
              sizeBytes: artifact.bytes.byteLength,
            },
          },
          authorization
        )
        if (projected?.payload.type !== "artifact") return emptyError(503)
        return new Response(Buffer.from(artifact.bytes), {
          headers: {
            "content-type": projected.payload.mediaType,
            "content-length": String(projected.payload.sizeBytes),
            "content-disposition": `attachment; filename*=UTF-8''${encodedFilename(projected.payload.name)}`,
          },
        })
      } catch {
        return projectedErrorResponse(
          authorizer.authorize,
          context.req.raw,
          agentId,
          sessionId,
          "temporarily_unavailable",
          true,
          503
        )
      }
    }
  )

  app.post(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/runs",
    async (context) => {
      if (context.req.header("origin") !== options.publicOrigin)
        return emptyError(403)
      const agentId = context.req.param("agentId")
      const threadId = context.req.param("sessionId")
      const candidate = await boundedJson(context.req.raw, 1_100_000)
      const parsed = RunAgentInputSchema.safeParse(candidate)
      const input = parsed.success
        ? normalizeRunInput(parsed.data, threadId)
        : undefined
      if (!input) return emptyError(400)
      const operation: GuestOperation = input.resume
        ? "interactions:respond"
        : "messages:create"
      const primary = await authorizer.authorize(context.req.raw, {
        agentId,
        sessionId: threadId,
        operation,
      })
      const read = primary
        ? await authorizer.authorize(context.req.raw, {
            agentId,
            sessionId: threadId,
            operation: "messages:read",
          })
        : undefined
      const errors = read
        ? await authorizer.authorize(context.req.raw, {
            agentId,
            sessionId: threadId,
            operation: "errors:read",
          })
        : undefined
      if (
        !primary ||
        !read ||
        !errors ||
        !sameGuestBinding(primary, read) ||
        !sameGuestBinding(primary, errors)
      )
        return emptyError(401)
      const sessionId = options.runtime.runtime.resolveSessionId(
        agentId,
        threadId
      )
      if (!sessionId) return emptyError(404)
      const scope = { agentId, sessionId, threadId }
      try {
        await options.runtime.runtime.getSession(agentId, sessionId)
        const subscription = await options.runtime.sessions.start(
          scope,
          input,
          createGuestRunAccess(
            read,
            errors,
            scope,
            input.runId,
            now,
            `${read.tokenId}:${++subscriberSequence}`
          )
        )
        return createRunStreamResponse(subscription, {
          signal: context.req.raw.signal,
          expiresAt:
            Math.min(
              read.authorizationExpiresAt,
              errors.authorizationExpiresAt
            ) * 1_000,
          now,
          schedule,
          cancel,
        })
      } catch (cause) {
        return cause instanceof ServerRunConflictError
          ? projectGuestError(errors, "request_failed", false, 409)
          : projectGuestError(errors, "temporarily_unavailable", true, 503)
      }
    }
  )

  app.post(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/runs/reconnect",
    async (context) => {
      if (context.req.header("origin") !== options.publicOrigin)
        return emptyError(403)
      const agentId = context.req.param("agentId")
      const threadId = context.req.param("sessionId")
      const read = await authorizer.authorize(context.req.raw, {
        agentId,
        sessionId: threadId,
        operation: "messages:read",
      })
      const errors = read
        ? await authorizer.authorize(context.req.raw, {
            agentId,
            sessionId: threadId,
            operation: "errors:read",
          })
        : undefined
      if (!read || !errors || !sameGuestBinding(read, errors))
        return emptyError(401)
      const candidate = await boundedJson(context.req.raw, 16_384)
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        typeof (candidate as { runId?: unknown }).runId !== "string" ||
        !validIdentifier((candidate as { runId: string }).runId) ||
        (candidate as { threadId?: unknown }).threadId !== threadId ||
        Object.keys(candidate).some(
          (key) => key !== "threadId" && key !== "runId" && key !== "after"
        ) ||
        ((candidate as { after?: unknown }).after !== undefined &&
          (!Number.isSafeInteger((candidate as { after: number }).after) ||
            (candidate as { after: number }).after < 0))
      )
        return emptyError(400)
      const sessionId = options.runtime.runtime.resolveSessionId(
        agentId,
        threadId
      )
      if (!sessionId) return emptyError(404)
      const runId = (candidate as { runId: string }).runId
      const scope = { agentId, sessionId, threadId }
      try {
        await options.runtime.runtime.getSession(agentId, sessionId)
        const subscription = await options.runtime.sessions.recover(
          scope,
          {
            threadId,
            runId,
            ...((candidate as { after?: number }).after === undefined
              ? {}
              : { after: (candidate as { after: number }).after }),
          },
          createGuestRunAccess(
            read,
            errors,
            scope,
            runId,
            now,
            `${read.tokenId}:${++subscriberSequence}`
          )
        )
        return createRunStreamResponse(subscription, {
          signal: context.req.raw.signal,
          expiresAt:
            Math.min(
              read.authorizationExpiresAt,
              errors.authorizationExpiresAt
            ) * 1_000,
          now,
          schedule,
          cancel,
        })
      } catch (cause) {
        return cause instanceof ServerRunConflictError
          ? projectGuestError(errors, "request_failed", false, 409)
          : projectGuestError(errors, "temporarily_unavailable", true, 503)
      }
    }
  )

  app.post(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/runs/stop",
    async (context) => {
      if (context.req.header("origin") !== options.publicOrigin)
        return emptyError(403)
      const agentId = context.req.param("agentId")
      const threadId = context.req.param("sessionId")
      const authorization = await authorizer.authorize(context.req.raw, {
        agentId,
        sessionId: threadId,
        operation: "messages:stop",
      })
      if (!authorization) return emptyError(401)
      const sessionId = options.runtime.runtime.resolveSessionId(
        agentId,
        threadId
      )
      if (!sessionId) return emptyError(404)
      try {
        const status = await options.runtime.sessions.stop(
          { agentId, sessionId },
          guestControllerId(authorization)
        )
        return Response.json(
          { status },
          { status: status === "stopping" ? 202 : 200 }
        )
      } catch {
        return emptyError(404)
      }
    }
  )

  app.onError(() => emptyError(503))
  app.notFound(() => emptyError(404))

  return {
    app,
    authorizeEventUpgrade: events.authorizeUpgrade,
    openEvents: events.open,
  }
}
