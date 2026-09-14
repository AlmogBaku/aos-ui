import { RunAgentInputSchema, type RunAgentInput } from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"
import type { Context } from "hono"

import { RunStopResponseSchema } from "../../protocol"
import type { ProxyAppOptions } from "../app"
import type {
  NewTurnRunInput,
  ResumeRunInput,
  ServerAttachmentStages,
  ServerRuntime,
} from "../core/runtime"
import type { CoordinatedRunSubscription } from "../core/session-coordinator"
import { redactForLog } from "../redaction"
import { boundedJson, errorResponse, validIdentifier } from "./http"
import type { ProxyRouteApp } from "./types"

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

export function normalizeRunInput(
  candidate: RunAgentInput,
  threadId: string,
  rewindSourceId?: string
): NewTurnRunInput | ResumeRunInput | undefined {
  if (candidate.threadId !== threadId || !validIdentifier(candidate.runId))
    return undefined
  const base = {
    threadId,
    runId: candidate.runId,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  }
  if (candidate.resume !== undefined) {
    if (candidate.messages.length !== 0 || candidate.resume.length === 0)
      return undefined
    return {
      ...base,
      messages: [],
      resume: candidate.resume.map(({ interruptId, status, payload }) => ({
        interruptId,
        status,
        ...(payload === undefined ? {} : { payload }),
      })),
    }
  }
  const message = candidate.messages[0]
  if (candidate.messages.length !== 1 || message?.role !== "user")
    return undefined
  return {
    ...base,
    messages: [{ id: message.id, role: "user", content: message.content }],
    ...(rewindSourceId === undefined ? {} : { rewindSourceId }),
  }
}

type RunStreamOptions = {
  signal?: AbortSignal
  expiresAt?: number
  now?: () => number
  schedule?: (delayMs: number, task: () => void) => unknown
  cancel?: (timer: unknown) => void
}

export function createRunStreamResponse(
  subscription: CoordinatedRunSubscription,
  options: RunStreamOptions = {}
) {
  const encoder = new EventEncoder({ accept: "text/event-stream" })
  const textEncoder = new TextEncoder()
  const iterator = subscription.events[Symbol.asyncIterator]()
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((delayMs: number, task: () => void) => setTimeout(task, delayMs))
  const cancel =
    options.cancel ?? ((timer: unknown) => clearTimeout(timer as number))
  let closed = false
  let timer: unknown
  const close = () => {
    if (closed) return
    closed = true
    if (timer !== undefined) cancel(timer)
    options.signal?.removeEventListener("abort", close)
    subscription.close()
  }
  options.signal?.addEventListener("abort", close, { once: true })
  if (options.expiresAt !== undefined)
    timer = schedule(Math.max(0, options.expiresAt - now()), close)
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) return
        try {
          const result = await iterator.next()
          if (result.done) {
            close()
            controller.close()
            return
          }
          const { sequence, event } = result.value
          controller.enqueue(
            textEncoder.encode(`id: ${sequence}\n${encoder.encodeSSE(event)}`)
          )
          if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
            close()
            await iterator.return?.()
            controller.close()
          }
        } catch {
          close()
          controller.error(new Error("AOS run stream failed"))
        }
      },
      async cancel() {
        close()
        await iterator.return?.()
      },
    }),
    { headers: { "content-type": encoder.getContentType() } }
  )
}

function access(
  context: Context<{ Variables: { requestId: string } }>,
  principalId: string
) {
  return {
    subscriberId: context.get("requestId"),
    controllerId: principalId,
    lane: "operator" as const,
    canControl: true,
  }
}

export function registerRunRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  attachmentStages: ServerAttachmentStages,
  requireRuntime: (request: Request) => Promise<RuntimeBinding>
) {
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

    const candidate = await boundedJson(context.req.raw, 1_100_000)
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return errorResponse("invalid_request", 400)
    const inputRecord = candidate as Record<string, unknown>
    const forwarded = inputRecord.forwardedProps
    const forwardedRecord =
      forwarded && typeof forwarded === "object" && !Array.isArray(forwarded)
        ? (forwarded as Record<string, unknown>)
        : undefined
    const stageId = forwardedRecord?.aosAttachmentStageId
    const rewindSourceId = forwardedRecord?.["aos.rewindSourceId"]
    if (
      (forwardedRecord &&
        Object.keys(forwardedRecord).some(
          (key) =>
            key !== "aosAttachmentStageId" && key !== "aos.rewindSourceId"
        )) ||
      (stageId !== undefined &&
        (typeof stageId !== "string" || !validIdentifier(stageId))) ||
      (rewindSourceId !== undefined &&
        (typeof rewindSourceId !== "string" ||
          !validIdentifier(rewindSourceId)))
    )
      return errorResponse("invalid_request", 400)

    await runtime.getSession(agentId, sessionId)
    const stage =
      typeof stageId === "string"
        ? attachmentStages.take(agentId, threadId, stageId)
        : undefined
    if (typeof stageId === "string" && !stage)
      return errorResponse("invalid_request", 400)

    let projected: unknown = candidate
    if (stage) {
      const text = runText(candidate)
      if (text === undefined || !Array.isArray(inputRecord.messages)) {
        await stage.cleanup().catch(() => undefined)
        return errorResponse("invalid_request", 400)
      }
      projected = {
        ...inputRecord,
        messages: [
          {
            ...(inputRecord.messages[0] as Record<string, unknown>),
            content: stage.appendTo(text),
          },
        ],
        forwardedProps:
          rewindSourceId === undefined
            ? {}
            : { "aos.rewindSourceId": rewindSourceId },
      }
    }
    const parsed = RunAgentInputSchema.safeParse(projected)
    if (!parsed.success) {
      await stage?.cleanup().catch(() => undefined)
      return errorResponse("invalid_request", 400)
    }
    const input = normalizeRunInput(
      parsed.data,
      threadId,
      rewindSourceId as string | undefined
    )
    if (!input) {
      await stage?.cleanup().catch(() => undefined)
      return errorResponse("invalid_request", 400)
    }

    try {
      const subscription = await options.runtimeInstance.sessions.start(
        { agentId, sessionId, threadId },
        input,
        access(context, principalId)
      )
      return createRunStreamResponse(subscription, {
        signal: context.req.raw.signal,
      })
    } catch (cause) {
      await stage?.cleanup().catch(() => undefined)
      options.logger.error(
        redactForLog({
          event: "run.start.failed",
          requestId: context.get("requestId"),
          error: cause,
        })
      )
      throw cause
    }
  }

  app.post("/api/aos/v1/agents/:agentId/sessions/:sessionId/runs", runHandler)

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
      await runtime.getSession(agentId, sessionId)
      const input = await boundedJson(context.req.raw)
      if (!input || typeof input !== "object" || Array.isArray(input))
        return errorResponse("invalid_request", 400)
      const value = input as Record<string, unknown>
      if (
        Object.keys(value).some(
          (key) => !["threadId", "runId", "after"].includes(key)
        ) ||
        value.threadId !== threadId ||
        typeof value.runId !== "string" ||
        !validIdentifier(value.runId) ||
        (value.after !== undefined &&
          (!Number.isSafeInteger(value.after) || (value.after as number) < 0))
      )
        return errorResponse("invalid_request", 400)

      const subscription = await options.runtimeInstance.sessions.recover(
        { agentId, sessionId, threadId },
        {
          threadId,
          runId: value.runId,
          ...(typeof value.after === "number" ? { after: value.after } : {}),
        },
        access(context, principalId)
      )
      return createRunStreamResponse(subscription, {
        signal: context.req.raw.signal,
      })
    }
  )

  app.post(
    "/api/aos/v1/agents/:agentId/sessions/:sessionId/runs/stop",
    async (context) => {
      const { runtime, principalId } = await requireRuntime(context.req.raw)
      if (context.req.header("origin") !== options.publicOrigin)
        return errorResponse("forbidden", 403)
      const agentId = context.req.param("agentId")
      const threadId = context.req.param("sessionId")
      const sessionId = runtime.resolveSessionId(agentId, threadId)
      if (!sessionId) return errorResponse("not_found", 404)
      await runtime.getSession(agentId, sessionId)
      const status = await options.runtimeInstance.sessions.stop(
        { agentId, sessionId },
        principalId
      )
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
