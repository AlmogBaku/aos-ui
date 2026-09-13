import type { AGUIEvent } from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"
import type { Context } from "hono"

import { RunStopResponseSchema } from "../../protocol"
import type { ProxyAppOptions } from "../app"
import type {
  ServerAttachmentStages,
  ServerReconnectRequest,
  ServerRunEngine,
  ServerRunHandle,
  ServerRunScope,
  ServerRuntime,
} from "../runtime"
import { ServerRunConflictError } from "../runtime"
import { redactForLog } from "../redaction"
import { boundedJson, errorResponse, validIdentifier } from "./http"
import type { ProxyRouteApp } from "./types"

type OperatorActiveRun = {
  handle: ServerRunHandle
  runId: string
  engine: ServerRunEngine
  principalId: string
}

type RuntimeBinding = {
  runtime: ServerRuntime
  principalId: string
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

function interactionResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).length !== 3 ||
    typeof input.runId !== "string" ||
    !validIdentifier(input.runId) ||
    typeof input.requestId !== "string" ||
    !validIdentifier(input.requestId) ||
    !input.response ||
    typeof input.response !== "object" ||
    Array.isArray(input.response)
  )
    return undefined
  const response = input.response as Record<string, unknown>
  if (response.kind === "reject" && Object.keys(response).length === 1)
    return {
      runId: input.runId as string,
      requestId: input.requestId as string,
      response: { kind: "reject" as const },
    }
  if (
    response.kind !== "question" ||
    Object.keys(response).length !== 2 ||
    !Array.isArray(response.answers)
  )
    return undefined
  return {
    runId: input.runId as string,
    requestId: input.requestId as string,
    response: {
      kind: "question" as const,
      answers: response.answers,
    },
  }
}

function runStream(
  context: Context<{ Variables: { requestId: string } }>,
  key: string,
  active: OperatorActiveRun,
  activeRuns: Map<string, OperatorActiveRun>
) {
  const { handle } = active
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
  context.req.raw.signal.addEventListener("abort", disconnect, { once: true })
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
          if (activeRuns.get(key) === active) activeRuns.delete(key)
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

export function registerRunRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  activeRuns: Map<string, OperatorActiveRun>,
  runAdmissions: Set<string>,
  attachmentStages: ServerAttachmentStages,
  maxActiveRuns: number,
  requireRuntime: (request: Request) => Promise<RuntimeBinding>
) {
  const runKey = (scope: Pick<ServerRunScope, "agentId" | "sessionId">) =>
    `${scope.agentId}\u0000${scope.sessionId}`
  const runHandler = async (
    context: Context<{ Variables: { requestId: string } }>
  ) => {
    const { runtime, principalId } = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const agentId = context.req.param("agentId")
    const threadId = context.req.param("sessionId")
    if (!agentId || !threadId) return errorResponse("not_found", 404)
    const sessionId = runtime.resolveSessionId(agentId, threadId)
    if (!sessionId) return errorResponse("not_found", 404)
    const input = await boundedJson(context.req.raw, 1_100_000)
    if (input === undefined) return errorResponse("invalid_request", 400)
    const inputRecord =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined
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
      await runtime.getSession(agentId, sessionId)
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
    let handle: ServerRunHandle
    let runEngine: ServerRunEngine
    try {
      runEngine = options.runEngine ?? runtime.runs
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
      const publicError = runtime.publicError(cause)
      return cause instanceof ServerRunConflictError
        ? errorResponse("run_conflict", 409)
        : publicError
          ? errorResponse(publicError.code, publicError.status)
          : errorResponse("invalid_request", 400)
    } finally {
      runAdmissions.delete(key)
    }
    const active = {
      handle,
      runId: typeof inputRecord?.runId === "string" ? inputRecord.runId : "",
      engine: runEngine,
      principalId,
    }
    activeRuns.set(key, active)
    return runStream(context, key, active, activeRuns)
  }

  app.post("/api/aos/v1/agents/:agentId/sessions/:sessionId/runs", runHandler)
  app.post(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/interactions/respond",
    async (context) => {
      const { runtime } = await requireRuntime(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const agentId = context.req.param("agentId")
      const threadId = context.req.param("sessionId")
      const sessionId = runtime.resolveSessionId(agentId, threadId)
      if (!sessionId) return errorResponse("not_found", 404)
      const input = interactionResponse(
        await boundedJson(context.req.raw, 65_536)
      )
      if (!input) return errorResponse("invalid_request", 400)
      const scope = {
        agentId,
        sessionId,
        threadId,
        runId: input.runId,
      }
      const snapshot = await runtime.pendingInteractions(
        agentId,
        threadId,
        input.runId
      )
      const interrupt = snapshot.outcome?.interrupts.find(
        ({ id }) => id === input.requestId
      )
      const resume =
        input.response.kind === "reject"
          ? {
              interruptId: input.requestId,
              status: "cancelled" as const,
            }
          : {
              interruptId: input.requestId,
              status: "resolved" as const,
              payload:
                interrupt?.reason === "approval"
                  ? input.response.answers[0]?.[0]
                  : { answers: input.response.answers },
            }
      return context.json(await runtime.respondInteraction(scope, resume))
    }
  )

  app.post(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/runs/reconnect",
    async (context) => {
      const { runtime, principalId } = await requireRuntime(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const agentId = context.req.param("agentId")
      const threadId = context.req.param("sessionId")
      const sessionId = runtime.resolveSessionId(agentId, threadId)
      if (!sessionId) return errorResponse("not_found", 404)
      const input = await boundedJson(context.req.raw)
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 2 ||
        (input as { threadId?: unknown }).threadId !== threadId ||
        typeof (input as { runId?: unknown }).runId !== "string" ||
        !validIdentifier((input as { runId: string }).runId)
      )
        return errorResponse("invalid_request", 400)
      const runId = (input as { runId: string }).runId
      const scope = { agentId, sessionId, threadId }
      const key = runKey(scope)
      const active = activeRuns.get(key)
      if (
        !active ||
        active.principalId !== principalId ||
        active.runId !== runId
      )
        return errorResponse("not_found", 404)
      let handle: ServerRunHandle
      try {
        const request: ServerReconnectRequest = {
          threadId,
          runId,
          position: active.handle.recoveryPosition(),
        }
        active.handle.disconnect()
        handle = await active.engine.reconnect(scope, request)
      } catch {
        return errorResponse("temporarily_unavailable", 503)
      }
      const reconnected = { ...active, handle }
      activeRuns.set(key, reconnected)
      return runStream(context, key, reconnected, activeRuns)
    }
  )

  app.post(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/runs/stop",
    async (context) => {
      const { runtime, principalId } = await requireRuntime(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const agentId = context.req.param("agentId")
      const sessionId = runtime.resolveSessionId(
        agentId,
        context.req.param("sessionId")
      )
      if (!sessionId) return errorResponse("not_found", 404)
      const key = runKey({ agentId, sessionId })
      const active = activeRuns.get(key)
      if (!active || active.principalId !== principalId)
        return errorResponse("not_found", 404)
      let status: "stopping" | "idle"
      try {
        status = await active.handle.stop()
      } catch {
        return errorResponse("temporarily_unavailable", 503)
      }
      if (status === "idle" && activeRuns.get(key) === active)
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
}
