import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"
import { Hono } from "hono"

import {
  SessionHistoryResponseSchema,
  type Session,
  type SessionHistoryResponse,
} from "../../protocol"
import type {
  GuestAuthorization,
  GuestInvitationService,
  GuestOperation,
} from "../auth/guest-invitation"
import { projectGuestOutbound } from "../auth/guest-projection"
import type { ReconnectCursorCodec } from "../events/cursor"
import {
  createEventsSocket,
  type EventsSocket,
  type EventSocketServerFrame,
} from "../events/socket"
import type { createHermesContentOperations } from "../runtimes/hermes/content"
import {
  HermesRunEngine,
  type HermesReconnectRequest,
  type HermesRunHandle,
  type HermesRunNative,
  type HermesRunScope,
} from "../runtimes/hermes/run"
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

type GuestHermesAdapter = HermesRunNative & {
  getSession(agentId: string, storedSessionId: string): Promise<Session>
  history(
    agentId: string,
    storedSessionId: string,
    limit: number,
    offset: number
  ): Promise<SessionHistoryResponse>
}

type GuestRunOperations = {
  start(scope: HermesRunScope, input: unknown): Promise<HermesRunHandle>
  reconnect(
    scope: HermesRunScope,
    input: HermesReconnectRequest
  ): Promise<HermesRunHandle>
}

type GuestContentOperations = Pick<
  ReturnType<typeof createHermesContentOperations>,
  "artifact"
>

export type GuestListenerServiceOptions = {
  publicOrigin: string
  deploymentId: string
  bootEpoch: string
  invitations: GuestInvitationService
  cursor: ReconnectCursorCodec
  /** A dedicated guest-lane adapter; never pass an operator-bound adapter. */
  hermes: GuestHermesAdapter
  /** Test seam; production should use the default engine bound to `hermes`. */
  runs?: GuestRunOperations
  /** Existing content service bound to the same dedicated guest adapter. */
  content?: GuestContentOperations
  maxActiveRuns?: number
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

function bearerToken(request: Request) {
  const value = request.headers.get("authorization")
  const match = value === null ? null : /^Bearer ([^\s]{1,4096})$/u.exec(value)
  return match?.[1]
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
  const agentId = url.searchParams.get("agentId") ?? ""
  const sessionId = url.searchParams.get("sessionId") ?? ""
  const storedId = storedSessionId(agentId, sessionId)
  return storedId ? { agentId, sessionId, storedId } : undefined
}

function storedSessionId(agentId: string, sessionId: string) {
  if (agentId.length === 0 || agentId.length > 256 || sessionId.length > 1_024)
    return undefined
  const match = /^hermes:([^:]+):(.+)$/u.exec(sessionId)
  if (!match) return undefined
  try {
    const owner = decodeURIComponent(match[1])
    const storedId = decodeURIComponent(match[2])
    return owner === agentId && storedId.length > 0 && storedId.length <= 256
      ? storedId
      : undefined
  } catch {
    return undefined
  }
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

async function authorize(
  invitations: GuestInvitationService,
  request: Request,
  target: { agentId: string; sessionId: string; operation: GuestOperation },
  now: () => number
) {
  const token = bearerToken(request)
  if (!token) return undefined
  return verifyAuthorization(invitations, token, target, now)
}

async function verifyAuthorization(
  invitations: GuestInvitationService,
  token: string,
  target: { agentId: string; sessionId: string; operation: GuestOperation },
  now: () => number
) {
  const authorization = await invitations.verify(token, target)
  return authorization?.sessionId === target.sessionId &&
    authorizationActive(authorization, now)
    ? authorization
    : undefined
}

function authorizationActive(
  authorization: { authorizationExpiresAt: number },
  now: () => number
) {
  let current: number
  try {
    current = now()
  } catch {
    return undefined
  }
  return (
    Number.isSafeInteger(current) &&
    authorization.authorizationExpiresAt * 1_000 > current
  )
}

function projectHistory(
  history: SessionHistoryResponse,
  authorization: GuestAuthorization
) {
  return {
    sessionId: history.sessionId,
    messages: history.messages.flatMap((message) => {
      if (message.role === "system") return []
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

function emptyError(status: number) {
  return new Response(null, { status })
}

async function projectedErrorResponse(
  options: GuestListenerServiceOptions,
  now: () => number,
  request: Request,
  agentId: string,
  sessionId: string,
  code: "not_found" | "request_failed" | "temporarily_unavailable",
  retryable: boolean,
  status: number
) {
  const authorization = await authorize(
    options.invitations,
    request,
    {
      agentId,
      sessionId,
      operation: "errors:read",
    },
    now
  )
  if (!authorization) return emptyError(status)
  const projected = projectGuestOutbound(
    {
      transport: "error",
      agentId,
      sessionId,
      payload: { type: "error", code, retryable },
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

function encodedFilename(filename: string) {
  return encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function runKey(scope: Pick<HermesRunScope, "agentId" | "sessionId">) {
  return `${scope.agentId.length}:${scope.agentId}${scope.sessionId}`
}

type GuestRunBinding = Pick<
  GuestAuthorization,
  "lane" | "principalId" | "invitationId" | "tokenId" | "agentId" | "sessionId"
>

function sameRunBinding(
  binding: GuestRunBinding,
  authorization: GuestAuthorization
) {
  return (
    binding.lane === authorization.lane &&
    binding.principalId === authorization.principalId &&
    binding.invitationId === authorization.invitationId &&
    binding.tokenId === authorization.tokenId &&
    binding.agentId === authorization.agentId &&
    binding.sessionId === authorization.sessionId
  )
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

function safeMessageId(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    ? value
    : undefined
}

function publicErrorCode(code: unknown) {
  return code === "AOS_RESET_REQUIRED" ||
    code === "AOS_CONNECTION_INTERRUPTED" ||
    code === "AOS_SEND_UNCERTAIN"
    ? { code: "temporarily_unavailable" as const, retryable: true }
    : { code: "request_failed" as const, retryable: false }
}

function projectRunStream(input: {
  handle: HermesRunHandle
  scope: HermesRunScope
  runId: string
  read: GuestAuthorization
  errors: GuestAuthorization
  onTerminal(): void
}) {
  const encoder = new EventEncoder({ accept: "text/event-stream" })
  const textEncoder = new TextEncoder()
  const iterator = input.handle.events[Symbol.asyncIterator]()
  let state: "open" | "closed" | "cancelled" = "open"
  let activeMessageId: string | undefined
  let messageStarted = false
  let readInFlight: Promise<IteratorResult<AGUIEvent>> | undefined

  const projectedEvent = (candidate: AGUIEvent): AGUIEvent | undefined => {
    if (!EventSchemas.safeParse(candidate).success) return undefined
    if (candidate.type === EventType.RUN_STARTED)
      return {
        type: EventType.RUN_STARTED,
        threadId: input.scope.threadId,
        runId: input.runId,
      }
    if (candidate.type === EventType.TEXT_MESSAGE_START) {
      if (candidate.role !== "assistant") return undefined
      activeMessageId = safeMessageId(candidate.messageId)
      messageStarted = false
      return undefined
    }
    if (candidate.type === EventType.TEXT_MESSAGE_CONTENT) {
      if (
        activeMessageId === undefined ||
        candidate.messageId !== activeMessageId
      )
        return undefined
      const projected = projectGuestOutbound(
        {
          transport: "ag-ui",
          agentId: input.scope.agentId,
          sessionId: input.scope.threadId,
          payload: {
            type: "message",
            role: "assistant",
            text: candidate.delta,
          },
        },
        input.read
      )
      if (
        projected?.payload.type !== "message" ||
        projected.payload.text === undefined
      )
        return undefined
      return {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: activeMessageId,
        delta: projected.payload.text,
      }
    }
    if (candidate.type === EventType.TEXT_MESSAGE_END) {
      if (
        !messageStarted ||
        activeMessageId === undefined ||
        candidate.messageId !== activeMessageId
      )
        return undefined
      const messageId = activeMessageId
      activeMessageId = undefined
      messageStarted = false
      return { type: EventType.TEXT_MESSAGE_END, messageId }
    }
    if (candidate.type === EventType.RUN_FINISHED) {
      input.onTerminal()
      return {
        type: EventType.RUN_FINISHED,
        threadId: input.scope.threadId,
        runId: input.runId,
      }
    }
    if (candidate.type === EventType.RUN_ERROR) {
      const error = publicErrorCode(candidate.code)
      const projected = projectGuestOutbound(
        {
          transport: "error",
          agentId: input.scope.agentId,
          sessionId: input.scope.threadId,
          payload: { type: "error", ...error },
        },
        input.errors
      )
      input.onTerminal()
      return projected?.payload.type === "error"
        ? {
            type: EventType.RUN_ERROR,
            code: projected.payload.code,
            message: "Guest run failed",
          }
        : undefined
    }
    return undefined
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (state !== "open" || readInFlight) return
      try {
        while (state === "open") {
          readInFlight = Promise.resolve(iterator.next())
          const result = await readInFlight
          if (state !== "open") return
          if (result.done) {
            state = "closed"
            controller.close()
            return
          }
          const event = projectedEvent(result.value)
          if (!event) continue
          if (
            event.type === EventType.TEXT_MESSAGE_CONTENT &&
            !messageStarted
          ) {
            messageStarted = true
            controller.enqueue(
              textEncoder.encode(
                encoder.encodeSSE({
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: event.messageId,
                  role: "assistant",
                })
              )
            )
          }
          controller.enqueue(textEncoder.encode(encoder.encodeSSE(event)))
          if (
            event.type === EventType.RUN_FINISHED ||
            event.type === EventType.RUN_ERROR
          ) {
            state = "closed"
            await iterator.return?.()
            controller.close()
          }
          return
        }
      } catch {
        if (state === "open") {
          state = "closed"
          input.onTerminal()
          controller.error(new Error("Guest run stream failed"))
        }
      } finally {
        readInFlight = undefined
      }
    },
    async cancel() {
      if (state !== "open") return
      state = "cancelled"
      input.handle.disconnect()
      await Promise.resolve(iterator.return?.()).catch(() => undefined)
    },
  })
  return new Response(stream, {
    headers: { "content-type": encoder.getContentType() },
  })
}

export function createGuestListenerService(
  options: GuestListenerServiceOptions
) {
  const app = new Hono()
  const now = options.now ?? Date.now
  const runs = options.runs ?? new HermesRunEngine(options.hermes)
  const maxActiveRuns = options.maxActiveRuns ?? 32
  const schedule =
    options.schedule ??
    ((delayMs: number, task: () => void) => setTimeout(task, delayMs))
  const cancel =
    options.cancel ?? ((timer: unknown) => clearTimeout(timer as number))
  const activeRuns = new Map<
    string,
    {
      runId: string
      handle: HermesRunHandle
      binding: GuestRunBinding
      expiresAt: number
      expiryTimer?: unknown
    }
  >()
  const admissions = new Set<string>()

  function removeActive(key: string, handle: HermesRunHandle) {
    const active = activeRuns.get(key)
    if (!active || active.handle !== handle) return
    activeRuns.delete(key)
    if (active.expiryTimer !== undefined) cancel(active.expiryTimer)
  }

  function activate(
    key: string,
    runId: string,
    handle: HermesRunHandle,
    binding: GuestRunBinding,
    expiresAt: number
  ) {
    const remaining = expiresAt - now()
    if (remaining <= 0) {
      handle.disconnect()
      return false
    }
    const previous = activeRuns.get(key)
    if (previous?.expiryTimer !== undefined) cancel(previous.expiryTimer)
    const active: {
      runId: string
      handle: HermesRunHandle
      binding: GuestRunBinding
      expiresAt: number
      expiryTimer?: unknown
    } = { runId, handle, binding, expiresAt }
    activeRuns.set(key, active)
    active.expiryTimer = schedule(remaining, () => {
      if (activeRuns.get(key) !== active) return
      activeRuns.delete(key)
      active.handle.disconnect()
    })
    return true
  }

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
      options.invitations,
      context.req.raw,
      {
        agentId: target.agentId,
        sessionId: target.sessionId,
        operation: "messages:read",
      },
      now
    )
    if (!authorization) return emptyError(401)
    try {
      await options.hermes.getSession(target.agentId, target.storedId)
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
        options.invitations,
        context.req.raw,
        { agentId, sessionId, operation: "messages:read" },
        now
      )
      if (!authorization) return emptyError(401)
      const storedId = storedSessionId(agentId, sessionId)
      const page = pageQuery(context.req.url)
      if (!storedId || !page) return emptyError(storedId ? 400 : 404)
      try {
        const history = SessionHistoryResponseSchema.parse(
          await options.hermes.history(
            agentId,
            storedId,
            page.limit,
            page.offset
          )
        )
        return context.json(projectHistory(history, authorization))
      } catch {
        return projectedErrorResponse(
          options,
          now,
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
      const authorization = await authorize(
        options.invitations,
        context.req.raw,
        { agentId, sessionId, operation: "artifacts:read" },
        now
      )
      if (!authorization) return emptyError(401)
      if (!storedSessionId(agentId, sessionId) || !options.content)
        return emptyError(404)
      try {
        const artifact = await options.content.artifact(
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
        if (projected?.payload.type !== "artifact")
          return projectedErrorResponse(
            options,
            now,
            context.req.raw,
            agentId,
            sessionId,
            "request_failed",
            false,
            503
          )
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
          now,
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
      const target = { agentId, sessionId: threadId }
      const create = await authorize(
        options.invitations,
        context.req.raw,
        {
          ...target,
          operation: "messages:create",
        },
        now
      )
      const read = create
        ? await authorize(
            options.invitations,
            context.req.raw,
            {
              ...target,
              operation: "messages:read",
            },
            now
          )
        : undefined
      const errors = read
        ? await authorize(
            options.invitations,
            context.req.raw,
            {
              ...target,
              operation: "errors:read",
            },
            now
          )
        : undefined
      if (
        !create ||
        !read ||
        !errors ||
        !sameRunBinding(create, read) ||
        !sameRunBinding(create, errors)
      )
        return emptyError(401)
      const sessionId = storedSessionId(agentId, threadId)
      if (!sessionId) return emptyError(404)
      const input = await boundedJson(context.req.raw, 1_100_000)
      if (input === undefined) return emptyError(400)
      const scope = { agentId, sessionId, threadId }
      const key = runKey(scope)
      if (activeRuns.has(key) || admissions.has(key)) return emptyError(409)
      if (activeRuns.size + admissions.size >= maxActiveRuns)
        return emptyError(503)
      admissions.add(key)
      try {
        await options.hermes.getSession(agentId, sessionId)
        if (!authorizationActive(create, now)) return emptyError(401)
        const handle = await runs.start(scope, input)
        const runId =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { runId?: unknown }).runId === "string"
            ? (input as { runId: string }).runId
            : ""
        if (
          !activate(
            key,
            runId,
            handle,
            create,
            create.authorizationExpiresAt * 1_000
          )
        )
          return emptyError(401)
        return projectRunStream({
          handle,
          scope,
          runId,
          read,
          errors,
          onTerminal() {
            removeActive(key, handle)
          },
        })
      } catch {
        return emptyError(503)
      } finally {
        admissions.delete(key)
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
      const target = { agentId, sessionId: threadId }
      const read = await authorize(
        options.invitations,
        context.req.raw,
        {
          ...target,
          operation: "messages:read",
        },
        now
      )
      const errors = read
        ? await authorize(
            options.invitations,
            context.req.raw,
            {
              ...target,
              operation: "errors:read",
            },
            now
          )
        : undefined
      if (!read || !errors) return emptyError(401)
      const sessionId = storedSessionId(agentId, threadId)
      if (!sessionId) return emptyError(404)
      const candidate = await boundedJson(context.req.raw, 16_384)
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        Object.keys(candidate).length !== 2 ||
        !Object.hasOwn(candidate, "threadId") ||
        !Object.hasOwn(candidate, "runId") ||
        (candidate as { threadId?: unknown }).threadId !== threadId ||
        !safeMessageId((candidate as { runId?: unknown }).runId)
      )
        return emptyError(400)
      const runId = (candidate as { runId: string }).runId
      const scope = { agentId, sessionId, threadId }
      const key = runKey(scope)
      const active = activeRuns.get(key)
      if (
        !active ||
        active.runId !== runId ||
        !sameRunBinding(active.binding, read)
      )
        return emptyError(404)
      try {
        if (!authorizationActive(read, now)) return emptyError(401)
        const position = active.handle.recoveryPosition()
        active.handle.disconnect()
        const handle = await runs.reconnect(scope, {
          threadId,
          runId,
          position,
        })
        if (
          !activate(
            key,
            runId,
            handle,
            read,
            read.authorizationExpiresAt * 1_000
          )
        )
          return emptyError(401)
        return projectRunStream({
          handle,
          scope,
          runId,
          read,
          errors,
          onTerminal() {
            removeActive(key, handle)
          },
        })
      } catch {
        return emptyError(503)
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
      const create = await authorize(
        options.invitations,
        context.req.raw,
        {
          agentId,
          sessionId: threadId,
          operation: "messages:create",
        },
        now
      )
      if (!create) return emptyError(401)
      const sessionId = storedSessionId(agentId, threadId)
      if (!sessionId) return emptyError(404)
      const key = runKey({ agentId, sessionId })
      const active = activeRuns.get(key)
      if (!active || !sameRunBinding(active.binding, create))
        return emptyError(404)
      try {
        if (!authorizationActive(create, now)) return emptyError(401)
        const status = await active.handle.stop()
        if (status === "idle") removeActive(key, active.handle)
        return context.json({ status }, status === "stopping" ? 202 : 200)
      } catch {
        return emptyError(503)
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
      options.invitations,
      token,
      {
        agentId: target.agentId,
        sessionId: target.sessionId,
        operation: "messages:read",
      },
      now
    )
    if (!authorization) return undefined
    try {
      await options.hermes.getSession(target.agentId, target.storedId)
    } catch {
      return undefined
    }
    return {
      invitationId: authorization.invitationId,
      authorizationRevision: authorization.tokenId,
      agentId: target.agentId,
      sessionId: target.sessionId,
      storedSessionId: target.storedId,
      expiresAt: authorization.authorizationExpiresAt * 1_000,
    }
  }

  function openEvents(
    upgrade: GuestEventUpgrade,
    peer: GuestEventPeer
  ): EventsSocket {
    const socket: EventsSocket = createEventsSocket({
      cursor: options.cursor,
      now,
      schedule,
      cancel,
      close: peer.close,
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
          await options.hermes.getSession(
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
        const { liveSessionId } = await options.hermes.resume({
          agentId: upgrade.agentId,
          sessionId: upgrade.storedSessionId,
          threadId: upgrade.sessionId,
        })
        const stop = await options.hermes.observe(
          liveSessionId,
          () => invalidate(),
          () => reset()
        )
        return { stop }
      },
    })
    return socket
  }

  return { app, authorizeEventUpgrade, openEvents }
}
