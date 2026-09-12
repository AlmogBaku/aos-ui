import type { AGUIEvent } from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"
import type { Context } from "hono"

import { RunStopResponseSchema } from "../../protocol"
import type { ProxyAppOptions } from "../app"
import type { HermesServerAdapter } from "../runtimes/hermes/adapter"
import {
  HermesRunEngine,
  HermesRunPublicError,
  type HermesRunHandle,
  type HermesRunScope,
} from "../runtimes/hermes/run"
import { HermesAttachmentStageRegistry } from "../runtimes/hermes/stage-registry"
import { redactForLog } from "../redaction"
import {
  boundedJson,
  errorResponse,
  storedSessionId,
  validIdentifier,
} from "./http"
import type { ProxyRouteApp } from "./types"

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

export function registerRunRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  activeRuns: Map<string, HermesRunHandle>,
  runAdmissions: Set<string>,
  attachmentStages: HermesAttachmentStageRegistry,
  maxActiveRuns: number,
  requireRuntime: (request: Request) => Promise<HermesServerAdapter>
) {
  const runKey = (scope: Pick<HermesRunScope, "agentId" | "sessionId">) =>
    `${scope.agentId}\u0000${scope.sessionId}`
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
}
