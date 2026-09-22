import {
  AOS_META_KEY,
  AosElicitationMetaSchema,
  AosPermissionMetaSchema,
} from "@aos/protocol/acp"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestion,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import type { AcpConnection, AcpPendingRequest } from "./types"

/**
 * Projects ACP's server→client requests onto the shared question composer: a
 * permission becomes one single-select question over its options, and an
 * elicitation carries the lossless questions the proxy put in `_meta.aos`.
 * One pending request per Session, replaced by the next one the proxy sends.
 */

type PendingEntry = {
  request: RuntimeQuestionRequest
  pending: AcpPendingRequest
}

/**
 * Elicitation answers travel under the `q0..qn` property keys the proxy puts
 * in `requestedSchema`: one string per single-select question, the full array
 * for a multi-select one.
 */
function elicitationContent(
  questions: readonly RuntimeQuestion[],
  answers: readonly string[][]
) {
  const content: Record<string, string | string[]> = {}
  questions.forEach((question, index) => {
    const answer = answers[index] ?? []
    content[`q${index}`] = question.multiple ? [...answer] : (answer[0] ?? "")
  })
  return content
}

export function createAcpInteractions({
  connection,
}: {
  connection: Pick<AcpConnection, "onPendingRequest">
}): RuntimeInteractionAdapter {
  const entries = new Map<string, PendingEntry>()
  const listeners = new Map<string, Set<() => void>>()
  let generated = 0

  function notify(sessionId: string) {
    listeners.get(sessionId)?.forEach((listener) => listener())
  }

  /**
   * The composer's view of one native request, or `undefined` when the proxy's
   * projection cannot be read. An elicitation carries its questions only in
   * `_meta.aos`, so a payload this contract rejects has nothing to render;
   * failing here instead would answer the runtime on the operator's behalf.
   * The request stays pending for the re-issue a later resume performs.
   */
  function project(
    pending: AcpPendingRequest,
    sessionId: string
  ): RuntimeQuestionRequest | undefined {
    if (pending.kind === "permission") {
      const meta = AosPermissionMetaSchema.safeParse(
        pending.request._meta?.[AOS_META_KEY]
      )
      const { title } = pending.request
      const prompt =
        pending.request.description ??
        (meta.success ? meta.data.message : undefined) ??
        title
      return {
        kind: "question",
        requestId: meta.success
          ? meta.data.interruptId
          : `acp-permission-${++generated}`,
        sessionId,
        questions: [
          {
            // A request that only names itself is said once, as the prompt.
            ...(prompt === title ? {} : { header: title }),
            prompt,
            options: pending.request.options.map((option) => ({
              label: option.name,
              value: option.optionId,
            })),
            multiple: false,
            custom: false,
          },
        ],
      }
    }
    const meta = AosElicitationMetaSchema.safeParse(
      pending.request._meta?.[AOS_META_KEY]
    )
    if (!meta.success) return undefined
    return {
      kind: "question",
      requestId: meta.data.interruptId,
      sessionId,
      questions: meta.data.questions,
    }
  }

  function take(request: RuntimeQuestionRequest) {
    const entry = entries.get(request.sessionId)
    if (!entry || entry.request.requestId !== request.requestId) return
    entries.delete(request.sessionId)
    notify(request.sessionId)
    return entry.pending
  }

  connection.onPendingRequest((pending) => {
    // Request-scoped elicitations belong to no Session the operator can see.
    const sessionId = pending.sessionId
    if (sessionId === undefined) return
    const request = project(pending, sessionId)
    if (request === undefined) return
    entries.set(sessionId, { request, pending })
    notify(sessionId)
  })

  return {
    async respond(request, response) {
      const pending = take(request)
      if (!pending) return
      if (pending.kind === "permission") {
        const optionId = response.answers[0]?.[0]
        if (optionId === undefined)
          throw new Error("A permission answer must select an option")
        pending.respond({ outcome: { outcome: "selected", optionId } })
        return
      }
      pending.respond({
        action: "accept",
        content: elicitationContent(request.questions, response.answers),
      })
    },

    async reject(request) {
      const pending = take(request)
      if (!pending) return
      if (pending.kind === "permission")
        pending.respond({ outcome: { outcome: "cancelled" } })
      else pending.respond({ action: "cancel" })
    },

    dismiss(request) {
      take(request)
    },

    getPending(threadId) {
      return entries.get(threadId)?.request
    },

    subscribe(threadId, listener) {
      const existing = listeners.get(threadId) ?? new Set<() => void>()
      existing.add(listener)
      listeners.set(threadId, existing)
      return () => {
        existing.delete(listener)
        if (existing.size === 0) listeners.delete(threadId)
      }
    },
  }
}
