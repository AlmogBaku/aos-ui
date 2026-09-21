import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
  RuntimeQuestionResponse,
} from "@/runtime-adapters/contracts"

/** Called when the operator answers a question; receives the thread and the answers matrix. */
export type FixtureAnswerAppender = (threadId: string, answers: string[][]) => void

/**
 * Deterministic RuntimeInteractionAdapter for fixture mode. One pending request
 * per thread; `register` is called by the chat model when a question scenario runs,
 * `respond` delivers the answers, and `reject` discards the request.
 */
export function createFixtureInteractions(
  onAnswer: FixtureAnswerAppender = () => {}
): RuntimeInteractionAdapter & { register(request: RuntimeQuestionRequest): void } {
  const pending = new Map<string, RuntimeQuestionRequest>()
  const listeners = new Map<string, Set<() => void>>()

  function notify(threadId: string) {
    listeners.get(threadId)?.forEach((l) => l())
  }

  function take(request: RuntimeQuestionRequest): boolean {
    const entry = pending.get(request.sessionId)
    if (!entry || entry.requestId !== request.requestId) return false
    pending.delete(request.sessionId)
    notify(request.sessionId)
    return true
  }

  return {
    register(request: RuntimeQuestionRequest) {
      pending.set(request.sessionId, request)
      notify(request.sessionId)
    },

    async respond(
      request: RuntimeQuestionRequest,
      response: RuntimeQuestionResponse
    ) {
      if (!take(request)) return
      onAnswer(request.sessionId, response.answers)
    },

    async reject(request: RuntimeQuestionRequest) {
      take(request)
    },

    getPending(threadId: string) {
      return pending.get(threadId)
    },

    subscribe(threadId: string, listener: () => void) {
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
