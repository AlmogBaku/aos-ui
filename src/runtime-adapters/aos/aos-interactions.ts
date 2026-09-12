import type {
  RuntimeInteractionAdapter,
  RuntimeQuestion,
  RuntimeQuestionRequest,
} from "../contracts"
import type { AosPendingInteraction } from "./aos-client"

type Client = {
  pendingInteraction(
    threadId: string,
    runId?: string
  ): Promise<AosPendingInteraction>
  respondToInteraction(
    threadId: string,
    runId: string,
    requestId: string,
    response: { kind: "question"; answers: string[][] } | { kind: "reject" }
  ): Promise<void>
  subscribeSessionInvalidation?(
    threadId: string,
    listener: () => void
  ): () => void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function choices(value: unknown) {
  const row = record(value)
  const items = row && Array.isArray(row.enum) ? row.enum : undefined
  return items?.flatMap((item) =>
    typeof item === "string" && item.trim() ? [{ label: item }] : []
  )
}

function questions(
  interrupt: NonNullable<AosPendingInteraction["outcome"]>["interrupts"][number]
) {
  const schema = record(interrupt.responseSchema)
  const properties = schema && record(schema.properties)
  const answers = properties && record(properties.answers)
  const prefix =
    answers && Array.isArray(answers.prefixItems) ? answers.prefixItems : []
  const values = prefix.flatMap((entry, index): RuntimeQuestion[] => {
    const question = record(entry)
    const items = question && record(question.items)
    const options = choices(items) ?? []
    const prompt =
      typeof question?.title === "string"
        ? question.title
        : (interrupt.message ?? "Question")
    return [
      {
        id: String(index),
        header: `Question ${index + 1}`,
        prompt,
        options,
        multiple: question?.maxItems !== 1,
        custom: !options.length,
      },
    ]
  })
  return values.length
    ? values
    : [
        {
          id: "0",
          header: "Question",
          prompt: interrupt.message ?? "Question",
          options: [],
          custom: true,
        },
      ]
}

function project(
  threadId: string,
  snapshot: AosPendingInteraction
): RuntimeQuestionRequest | undefined {
  const interrupt = snapshot.outcome?.interrupts[0]
  if (!interrupt) return undefined
  if (interrupt.reason === "approval") {
    const options = choices(interrupt.responseSchema) ?? []
    return {
      kind: "question",
      requestId: interrupt.id,
      sessionId: threadId,
      questions: [
        {
          id: "0",
          header: "Permission",
          prompt: interrupt.message ?? "Permission",
          options,
          custom: false,
        },
      ],
    }
  }
  return {
    kind: "question",
    requestId: interrupt.id,
    sessionId: threadId,
    questions: questions(interrupt),
  }
}

/** Pulls only provider-normalized, Session-owned interrupt snapshots. */
export function createAosInteractions(
  client: Client
): RuntimeInteractionAdapter {
  const state = new Map<
    string,
    {
      runId?: string
      pending?: RuntimeQuestionRequest
      listeners: Set<() => void>
    }
  >()
  const session = (threadId: string) => {
    let current = state.get(threadId)
    if (!current) {
      current = { listeners: new Set() }
      state.set(threadId, current)
    }
    return current
  }
  const refresh = async (threadId: string) => {
    const current = session(threadId)
    const snapshot = await client.pendingInteraction(threadId, current.runId)
    current.runId = snapshot.runId
    const next = project(threadId, snapshot)
    if (JSON.stringify(next) === JSON.stringify(current.pending)) return
    current.pending = next
    current.listeners.forEach((listener) => listener())
  }
  return {
    getPending(threadId) {
      return session(threadId).pending
    },
    subscribe(threadId, listener, onError) {
      const current = session(threadId)
      current.listeners.add(listener)
      void refresh(threadId).catch((reason) =>
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      )
      const refreshOnInvalidation = client.subscribeSessionInvalidation?.(
        threadId,
        () =>
          void refresh(threadId).catch((reason) =>
            onError?.(
              reason instanceof Error ? reason : new Error(String(reason))
            )
          )
      )
      return () => {
        current.listeners.delete(listener)
        refreshOnInvalidation?.()
      }
    },
    async respond(request, response) {
      const current = session(request.sessionId)
      if (!current.runId)
        throw new Error("AOS interaction has not been restored")
      await client.respondToInteraction(
        request.sessionId,
        current.runId,
        request.requestId,
        response
      )
      current.pending = undefined
      current.listeners.forEach((listener) => listener())
    },
    async reject(request) {
      const current = session(request.sessionId)
      if (!current.runId)
        throw new Error("AOS interaction has not been restored")
      await client.respondToInteraction(
        request.sessionId,
        current.runId,
        request.requestId,
        { kind: "reject" }
      )
      current.pending = undefined
      current.listeners.forEach((listener) => listener())
    },
  }
}
