import { createHash } from "node:crypto"

import {
  EventSchemas,
  EventType,
  RunAgentInputSchema,
  type AGUIEvent,
} from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"
import { Hono } from "hono"

import {
  SessionHistoryResponseSchema,
  type SessionHistoryResponse,
} from "../../protocol"
import type {
  GuestAuthorization,
  GuestInvitationService,
  GuestOperation,
  VerifiedGuestAuthorization,
} from "../auth/guest-invitation"
import {
  guestErrorDescription,
  projectGuestOutbound,
  type GuestPublicErrorCode,
} from "../auth/guest-projection"
import type {
  RuntimeInstance,
  NewTurnRunInput,
  ResumeRunInput,
  SessionScope,
} from "../core/runtime"
import { ServerRunConflictError } from "../core/runtime"
import type {
  CoordinatedRunSubscription,
  CoordinatorAccess,
} from "../core/session-coordinator"
import type { ReconnectCursorCodec } from "../events/cursor"
import {
  createEventsSocket,
  type EventsSocket,
  type EventSocketServerFrame,
} from "../events/socket"
import { boundedJson } from "../routes/http"

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const

const GUEST_EVENTS_COOKIE = "__Host-aos-guest-events"
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

export type GuestEventUpgrade = {
  invitationId: string
  authorizationRevision: string
  agentId: string
  sessionId: string
  storedSessionId: string
  expiresAt: number
}

export type GuestEventPeer = {
  send(raw: string): void
  close(code: number, reason: string): void
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function bearerToken(request: Request) {
  const value = request.headers.get("authorization")
  const match = value === null ? null : /^Bearer ([^\s]{1,4096})$/u.exec(value)
  return match?.[1]
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie")
  if (header === null || header.length > 8_192) return undefined
  const values = header
    .split(";")
    .map((item) => item.trim())
    .flatMap((item) => {
      const separator = item.indexOf("=")
      return separator > 0 && item.slice(0, separator) === name
        ? [item.slice(separator + 1)]
        : []
    })
  return values.length === 1 ? values[0] : undefined
}

function eventTarget(request: Request, pathname: string) {
  const url = new URL(request.url)
  if (
    url.pathname !== pathname ||
    url.search.length > 2_048 ||
    [...url.searchParams.keys()].some(
      (key) => key !== "agentId" && key !== "sessionId"
    ) ||
    url.searchParams.getAll("agentId").length !== 1 ||
    url.searchParams.getAll("sessionId").length !== 1
  )
    return undefined
  const agentId = url.searchParams.get("agentId")
  const sessionId = url.searchParams.get("sessionId")
  return validIdentifier(agentId) && validIdentifier(sessionId)
    ? { agentId, sessionId }
    : undefined
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

function authorizationActive(
  authorization: { authorizationExpiresAt: number },
  now: () => number
) {
  try {
    const current = now()
    return (
      Number.isSafeInteger(current) &&
      authorization.authorizationExpiresAt * 1_000 > current
    )
  } catch {
    return false
  }
}

async function verifyAuthorization(
  options: GuestListenerServiceOptions,
  token: string,
  target: { agentId: string; sessionId: string; operation: GuestOperation },
  now: () => number
) {
  const authorization = await options.invitations.verify(token, {
    runtimeId: options.runtime.id,
    ...target,
  })
  return authorization?.sessionId === target.sessionId &&
    authorizationActive(authorization, now)
    ? authorization
    : undefined
}

async function authorize(
  options: GuestListenerServiceOptions,
  request: Request,
  target: { agentId: string; sessionId: string; operation: GuestOperation },
  now: () => number
) {
  const token = bearerToken(request)
  return token ? verifyAuthorization(options, token, target, now) : undefined
}

function sameBinding(first: GuestAuthorization, second: GuestAuthorization) {
  return (
    first.runtimeId === second.runtimeId &&
    first.principalId === second.principalId &&
    first.invitationId === second.invitationId &&
    first.tokenId === second.tokenId &&
    first.agentId === second.agentId &&
    first.sessionId === second.sessionId
  )
}

function controllerId(authorization: GuestAuthorization) {
  return `guest:${authorization.tokenId}`
}

function emptyError(status: number) {
  return new Response(null, { status })
}

function projectedError(
  authorization: GuestAuthorization,
  code: GuestPublicErrorCode,
  retryable: boolean,
  status: number
) {
  const projected = projectGuestOutbound(
    {
      transport: "error",
      agentId: authorization.agentId,
      sessionId: authorization.sessionId,
      payload: {
        type: "error",
        code,
        description: guestErrorDescription(code),
        retryable,
      },
    },
    authorization
  )
  return projected
    ? new Response(JSON.stringify(projected), {
        status,
        headers: { "content-type": "application/json; charset=UTF-8" },
      })
    : emptyError(status)
}

async function projectedErrorResponse(
  options: GuestListenerServiceOptions,
  request: Request,
  agentId: string,
  sessionId: string,
  now: () => number,
  code: GuestPublicErrorCode,
  retryable: boolean,
  status: number
) {
  const authorization = await authorize(
    options,
    request,
    { agentId, sessionId, operation: "errors:read" },
    now
  )
  return authorization
    ? projectedError(authorization, code, retryable, status)
    : emptyError(status)
}

function projectHistory(
  history: SessionHistoryResponse,
  authorization: GuestAuthorization
) {
  return {
    sessionId: history.sessionId,
    messages: history.messages.flatMap((message) => {
      if (message.role === "system" || message.role === "activity") return []
      const content = message.content.flatMap((part) => {
        if (part.type !== "text") return []
        const projected = projectGuestOutbound(
          {
            transport: "rest",
            agentId: authorization.agentId,
            sessionId: authorization.sessionId,
            payload: {
              type: "message",
              role: message.role === "user" ? "guest" : "assistant",
              text: part.text,
            },
          },
          authorization
        )
        return projected?.payload.type === "message" &&
          projected.payload.text !== undefined
          ? [{ type: "text" as const, text: projected.payload.text }]
          : []
      })
      return content.length === 0
        ? []
        : [
            {
              id: message.id,
              role: message.role,
              content,
              createdAt: message.createdAt,
            },
          ]
    }),
    total: history.total,
    limit: history.limit,
    offset: history.offset,
    nextOffset: history.nextOffset,
  }
}

function encodedFilename(filename: string) {
  return encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function sanitizeRunInput(
  candidate: unknown,
  threadId: string
): NewTurnRunInput | ResumeRunInput | undefined {
  const parsed = RunAgentInputSchema.safeParse(candidate)
  if (
    !parsed.success ||
    parsed.data.threadId !== threadId ||
    !validIdentifier(parsed.data.runId)
  )
    return undefined
  const base = {
    threadId,
    runId: parsed.data.runId,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  }
  if (parsed.data.resume !== undefined) {
    if (parsed.data.messages.length !== 0 || parsed.data.resume.length === 0)
      return undefined
    return {
      ...base,
      messages: [],
      resume: parsed.data.resume.map(({ interruptId, status, payload }) => ({
        interruptId,
        status,
        ...(payload === undefined ? {} : { payload }),
      })),
    }
  }
  if (
    parsed.data.messages.length !== 1 ||
    parsed.data.messages[0]?.role !== "user"
  )
    return undefined
  const message = parsed.data.messages[0]
  return {
    ...base,
    messages: [{ id: message.id, role: "user", content: message.content }],
  }
}

function publicRunError(code: string | undefined) {
  if (code === "AOS_CONNECTION_INTERRUPTED")
    return { code, retryable: true } as const
  if (code === "AOS_SEND_UNCERTAIN") return { code, retryable: true } as const
  if (code === "AOS_INTERACTION_UNCERTAIN")
    return { code, retryable: true } as const
  if (code === "AOS_RESET_REQUIRED")
    return { code: "temporarily_unavailable", retryable: true } as const
  return { code: "request_failed", retryable: false } as const
}

function guestMessageId(tokenId: string, sourceId: string) {
  return `guest-message-${createHash("sha256")
    .update(tokenId)
    .update("\0")
    .update(sourceId)
    .digest("base64url")
    .slice(0, 24)}`
}

function runProjector(
  scope: SessionScope,
  runId: string,
  read: VerifiedGuestAuthorization,
  errors: VerifiedGuestAuthorization,
  now: () => number
) {
  const assistantMessages = new Set<string>()
  return (candidate: AGUIEvent): AGUIEvent | undefined => {
    if (
      !authorizationActive(read, now) ||
      !authorizationActive(errors, now) ||
      !EventSchemas.safeParse(candidate).success
    )
      return undefined
    if (candidate.type === EventType.RUN_STARTED)
      return { type: EventType.RUN_STARTED, threadId: scope.threadId, runId }
    if (candidate.type === EventType.TEXT_MESSAGE_START) {
      if (
        candidate.role !== "assistant" ||
        !validIdentifier(candidate.messageId)
      )
        return undefined
      assistantMessages.add(candidate.messageId)
      return {
        type: EventType.TEXT_MESSAGE_START,
        messageId: guestMessageId(read.tokenId, candidate.messageId),
        role: "assistant",
      }
    }
    if (candidate.type === EventType.TEXT_MESSAGE_CONTENT) {
      if (!assistantMessages.has(candidate.messageId)) return undefined
      const projected = projectGuestOutbound(
        {
          transport: "ag-ui",
          agentId: scope.agentId,
          sessionId: scope.threadId,
          payload: {
            type: "message",
            role: "assistant",
            text: candidate.delta,
          },
        },
        read
      )
      return projected?.payload.type === "message" &&
        projected.payload.text !== undefined
        ? {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: guestMessageId(read.tokenId, candidate.messageId),
            delta: projected.payload.text,
          }
        : undefined
    }
    if (candidate.type === EventType.TEXT_MESSAGE_END) {
      if (!assistantMessages.delete(candidate.messageId)) return undefined
      return {
        type: EventType.TEXT_MESSAGE_END,
        messageId: guestMessageId(read.tokenId, candidate.messageId),
      }
    }
    if (candidate.type === EventType.RUN_FINISHED) {
      if (candidate.outcome?.type === "interrupt") {
        const projected = projectGuestOutbound(
          {
            transport: "ag-ui",
            agentId: scope.agentId,
            sessionId: scope.threadId,
            payload: {
              type: "interrupt",
              interrupts: candidate.outcome.interrupts,
            },
          },
          read
        )
        if (projected?.payload.type !== "interrupt") return undefined
        return {
          type: EventType.RUN_FINISHED,
          threadId: scope.threadId,
          runId,
          outcome: {
            type: "interrupt",
            interrupts: [...projected.payload.interrupts],
          },
        }
      }
      return {
        type: EventType.RUN_FINISHED,
        threadId: scope.threadId,
        runId,
        outcome: { type: "success" },
      }
    }
    if (candidate.type === EventType.RUN_ERROR) {
      const error = publicRunError(candidate.code)
      const projected = projectGuestOutbound(
        {
          transport: "error",
          agentId: scope.agentId,
          sessionId: scope.threadId,
          payload: {
            type: "error",
            code: error.code,
            description: guestErrorDescription(error.code),
            retryable: error.retryable,
          },
        },
        errors
      )
      return projected?.payload.type === "error"
        ? {
            type: EventType.RUN_ERROR,
            code: projected.payload.code,
            message:
              projected.payload.description ??
              guestErrorDescription(projected.payload.code),
          }
        : undefined
    }
    return undefined
  }
}

function runAccess(
  read: VerifiedGuestAuthorization,
  errors: VerifiedGuestAuthorization,
  scope: SessionScope,
  runId: string,
  now: () => number,
  subscriberId: string
): CoordinatorAccess {
  return {
    subscriberId,
    controllerId: controllerId(read),
    lane: "guest",
    canControl: true,
    project: runProjector(scope, runId, read, errors, now),
  }
}

function projectRunStream(
  subscription: CoordinatedRunSubscription,
  expiresAt: number,
  now: () => number,
  schedule: (delayMs: number, task: () => void) => unknown,
  cancel: (timer: unknown) => void
) {
  const encoder = new EventEncoder({ accept: "text/event-stream" })
  const textEncoder = new TextEncoder()
  const iterator = subscription.events[Symbol.asyncIterator]()
  let closed = false
  const timer = schedule(Math.max(0, expiresAt - now()), () => {
    if (closed) return
    closed = true
    subscription.close()
  })
  const cleanup = () => {
    if (closed) return
    closed = true
    cancel(timer)
    subscription.close()
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        controller.close()
        return
      }
      try {
        const result = await iterator.next()
        if (result.done) {
          cleanup()
          controller.close()
          return
        }
        controller.enqueue(
          textEncoder.encode(encoder.encodeSSE(result.value.event))
        )
      } catch {
        cleanup()
        controller.error(new Error("Guest run stream failed"))
      }
    },
    async cancel() {
      cleanup()
      await Promise.resolve(iterator.return?.()).catch(() => undefined)
    },
  })
  return new Response(stream, {
    headers: { "content-type": encoder.getContentType() },
  })
}

function canonicalEventScope(scope: {
  workspaceId: string
  agentId: string
  sessionId: string
}) {
  const encode = (value: string) =>
    Buffer.from(value, "utf8").toString("base64url")
  return `ws1.${encode(scope.workspaceId)}.${encode(scope.agentId)}.${encode(scope.sessionId)}`
}

function projectEventFrame(raw: string, upgrade: GuestEventUpgrade) {
  let frame: EventSocketServerFrame
  try {
    frame = JSON.parse(raw) as EventSocketServerFrame
  } catch {
    return undefined
  }
  if (frame.type === "aos.error")
    return JSON.stringify({
      type: frame.type,
      version: 1,
      ...(frame.streamId === undefined ? {} : { streamId: frame.streamId }),
      code: frame.code,
    })
  if (
    frame.scope.workspaceId !== "guest" ||
    frame.scope.agentId !== upgrade.agentId ||
    frame.scope.sessionId !== upgrade.sessionId
  )
    return undefined
  if (frame.type === "aos.ready")
    return JSON.stringify({
      type: frame.type,
      version: 1,
      streamId: frame.streamId,
      scope: frame.scope,
      generation: frame.generation,
      read: "authoritative",
      ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
    })
  return JSON.stringify({
    type: frame.type,
    version: 1,
    streamId: frame.streamId,
    scope: frame.scope,
    generation: frame.generation,
    ...(frame.type === "aos.reset"
      ? { reason: "reconcile_required" as const }
      : {}),
  })
}

function inertSocket(): EventsSocket {
  return {
    receive: async () => undefined,
    drain: () => [],
    close: () => undefined,
  }
}

export function createGuestListenerService(
  options: GuestListenerServiceOptions
) {
  const app = new Hono()
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((delayMs: number, task: () => void) => setTimeout(task, delayMs))
  const cancel =
    options.cancel ?? ((timer: unknown) => clearTimeout(timer as number))
  const maxEventPeers = options.maxEventPeers ?? 64
  const maxEventPeersPerInvitation = options.maxEventPeersPerInvitation ?? 4
  let eventPeers = 0
  const eventPeersByInvitation = new Map<string, number>()
  let subscriberSequence = 0

  app.use("*", async (context, next) => {
    await next()
    for (const [name, value] of Object.entries(securityHeaders))
      context.header(name, value)
  })

  app.post("/api/guest/v1/events/authorize", async (context) => {
    if (context.req.header("origin") !== options.publicOrigin)
      return emptyError(403)
    const target = eventTarget(
      context.req.raw,
      "/api/guest/v1/events/authorize"
    )
    if (!target) return emptyError(404)
    const authorization = await authorize(
      options,
      context.req.raw,
      { ...target, operation: "messages:read" },
      now
    )
    if (!authorization) return emptyError(401)
    const storedSessionId = options.runtime.runtime.resolveSessionId(
      target.agentId,
      target.sessionId
    )
    if (!storedSessionId) return emptyError(404)
    try {
      await options.runtime.runtime.getSession(target.agentId, storedSessionId)
      const token = bearerToken(context.req.raw)
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
      const authorization = await authorize(
        options,
        context.req.raw,
        { agentId, sessionId, operation: "messages:read" },
        now
      )
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
          await options.runtime.runtime.history(
            agentId,
            storedSessionId,
            page.limit,
            page.offset
          )
        )
        return context.json(projectHistory(history, authorization))
      } catch {
        return projectedErrorResponse(
          options,
          context.req.raw,
          agentId,
          sessionId,
          now,
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
      const authorization = await authorize(
        options,
        context.req.raw,
        { agentId, sessionId, operation: "artifacts:read" },
        now
      )
      if (!authorization) return emptyError(401)
      const storedSessionId = options.runtime.runtime.resolveSessionId(
        agentId,
        sessionId
      )
      if (!storedSessionId) return emptyError(404)
      try {
        await options.runtime.runtime.getSession(agentId, storedSessionId)
        const artifact = await options.runtime.runtime.artifact(
          agentId,
          sessionId,
          context.req.param("artifactId")
        )
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
          options,
          context.req.raw,
          agentId,
          sessionId,
          now,
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
      const input = sanitizeRunInput(candidate, threadId)
      if (!input) return emptyError(400)
      const operation: GuestOperation = input.resume
        ? "interactions:respond"
        : "messages:create"
      const primary = await authorize(
        options,
        context.req.raw,
        { agentId, sessionId: threadId, operation },
        now
      )
      const read = primary
        ? await authorize(
            options,
            context.req.raw,
            { agentId, sessionId: threadId, operation: "messages:read" },
            now
          )
        : undefined
      const errors = read
        ? await authorize(
            options,
            context.req.raw,
            { agentId, sessionId: threadId, operation: "errors:read" },
            now
          )
        : undefined
      if (
        !primary ||
        !read ||
        !errors ||
        !sameBinding(primary, read) ||
        !sameBinding(primary, errors)
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
          runAccess(
            read,
            errors,
            scope,
            input.runId,
            now,
            `${read.tokenId}:${++subscriberSequence}`
          )
        )
        return projectRunStream(
          subscription,
          Math.min(read.authorizationExpiresAt, errors.authorizationExpiresAt) *
            1_000,
          now,
          schedule,
          cancel
        )
      } catch (cause) {
        return cause instanceof ServerRunConflictError
          ? projectedError(errors, "request_failed", false, 409)
          : projectedError(errors, "temporarily_unavailable", true, 503)
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
      const read = await authorize(
        options,
        context.req.raw,
        { agentId, sessionId: threadId, operation: "messages:read" },
        now
      )
      const errors = read
        ? await authorize(
            options,
            context.req.raw,
            { agentId, sessionId: threadId, operation: "errors:read" },
            now
          )
        : undefined
      if (!read || !errors || !sameBinding(read, errors)) return emptyError(401)
      const candidate = await boundedJson(context.req.raw, 16_384)
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        !validIdentifier((candidate as { runId?: unknown }).runId) ||
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
          runAccess(
            read,
            errors,
            scope,
            runId,
            now,
            `${read.tokenId}:${++subscriberSequence}`
          )
        )
        return projectRunStream(
          subscription,
          Math.min(read.authorizationExpiresAt, errors.authorizationExpiresAt) *
            1_000,
          now,
          schedule,
          cancel
        )
      } catch (cause) {
        return cause instanceof ServerRunConflictError
          ? projectedError(errors, "request_failed", false, 409)
          : projectedError(errors, "temporarily_unavailable", true, 503)
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
      const authorization = await authorize(
        options,
        context.req.raw,
        { agentId, sessionId: threadId, operation: "messages:stop" },
        now
      )
      if (!authorization) return emptyError(401)
      const sessionId = options.runtime.runtime.resolveSessionId(
        agentId,
        threadId
      )
      if (!sessionId) return emptyError(404)
      try {
        const status = await options.runtime.sessions.stop(
          { agentId, sessionId },
          controllerId(authorization)
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

  async function authorizeEventUpgrade(
    request: Request
  ): Promise<GuestEventUpgrade | undefined> {
    if (
      request.method !== "GET" ||
      request.headers.get("origin") !== options.publicOrigin
    )
      return undefined
    const target = eventTarget(request, "/api/guest/v1/events")
    if (!target) return undefined
    const token =
      bearerToken(request) ?? cookieValue(request, GUEST_EVENTS_COOKIE)
    if (!token) return undefined
    const authorization = await verifyAuthorization(
      options,
      token,
      { ...target, operation: "messages:read" },
      now
    )
    if (!authorization) return undefined
    const storedSessionId = options.runtime.runtime.resolveSessionId(
      target.agentId,
      target.sessionId
    )
    if (!storedSessionId) return undefined
    try {
      await options.runtime.runtime.getSession(target.agentId, storedSessionId)
    } catch {
      return undefined
    }
    return {
      invitationId: authorization.invitationId,
      authorizationRevision: authorization.tokenId,
      agentId: target.agentId,
      sessionId: target.sessionId,
      storedSessionId,
      expiresAt: authorization.authorizationExpiresAt * 1_000,
    }
  }

  function openEvents(
    upgrade: GuestEventUpgrade,
    peer: GuestEventPeer
  ): EventsSocket {
    const invitationPeers =
      eventPeersByInvitation.get(upgrade.invitationId) ?? 0
    if (
      eventPeers >= maxEventPeers ||
      invitationPeers >= maxEventPeersPerInvitation ||
      now() >= upgrade.expiresAt
    ) {
      peer.close(
        now() >= upgrade.expiresAt ? 4401 : 1013,
        now() >= upgrade.expiresAt
          ? "Authorization expired"
          : "Guest event peer limit exceeded"
      )
      return inertSocket()
    }
    eventPeers += 1
    eventPeersByInvitation.set(upgrade.invitationId, invitationPeers + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      eventPeers -= 1
      const remaining =
        (eventPeersByInvitation.get(upgrade.invitationId) ?? 1) - 1
      if (remaining === 0) eventPeersByInvitation.delete(upgrade.invitationId)
      else eventPeersByInvitation.set(upgrade.invitationId, remaining)
    }
    const socket = createEventsSocket({
      cursor: options.cursor,
      now,
      schedule,
      cancel,
      ...(options.maxEventStreamsPerPeer === undefined
        ? {}
        : { maxStreams: options.maxEventStreamsPerPeer }),
      close(code, reason) {
        release()
        peer.close(code, reason)
      },
      notify() {
        for (const raw of socket.drain()) {
          const projected = projectEventFrame(raw, upgrade)
          if (projected !== undefined) peer.send(projected)
        }
      },
      async authorize({ scope, streamId }) {
        if (
          now() >= upgrade.expiresAt ||
          scope.workspaceId !== "guest" ||
          scope.agentId !== upgrade.agentId ||
          scope.sessionId !== upgrade.sessionId
        )
          return null
        try {
          await options.runtime.runtime.getSession(
            upgrade.agentId,
            upgrade.storedSessionId
          )
        } catch {
          return null
        }
        return {
          expiresAt: upgrade.expiresAt,
          binding: {
            deploymentId: options.deploymentId,
            lane: "guest",
            invitationId: upgrade.invitationId,
            authorizationRevision: upgrade.authorizationRevision,
            scope: canonicalEventScope(scope),
            agentId: upgrade.agentId,
            sessionId: upgrade.sessionId,
            bootEpoch: options.bootEpoch,
            streamId,
          },
        }
      },
      async observe({ scope, invalidate, reset }) {
        if (
          scope.workspaceId !== "guest" ||
          scope.agentId !== upgrade.agentId ||
          scope.sessionId !== upgrade.sessionId
        )
          throw new Error("Invalid guest event scope")
        const stop = await options.runtime.runtime.subscribeSessionInvalidation(
          upgrade.agentId,
          upgrade.sessionId,
          invalidate,
          reset
        )
        return { stop }
      },
    })
    return {
      receive: (raw) => socket.receive(raw),
      drain: (maxFrames) => socket.drain(maxFrames),
      close() {
        release()
        socket.close()
      },
    }
  }

  return { app, authorizeEventUpgrade, openEvents }
}
