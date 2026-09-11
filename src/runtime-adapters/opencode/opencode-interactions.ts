import {
  OpenCodeEventSource,
  type OpenCodeQuestionRequest,
  type OpenCodeThreadState,
  type OpencodeClient,
} from "@assistant-ui/react-opencode"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "../contracts"
import { findOrphanedOpenCodeQuestion } from "./orphaned-question"

const REQUEST_OPTIONS = { throwOnError: true } as const
export type OpenCodeInteractionSource = {
  read(threadId: string):
    | {
        state: OpenCodeThreadState
        questions: readonly OpenCodeQuestionRequest[]
      }
    | undefined
  subscribe(listener: () => void): () => void
}
type EventSource = Pick<OpenCodeEventSource, "subscribe">
type SessionQuestions = {
  listed: readonly OpenCodeQuestionRequest[]
  loaded: boolean
  resolved: Set<string>
  seen: Map<string, RuntimeQuestionRequest>
  inFlight: Set<string>
  expired?: RuntimeQuestionRequest
  snapshot?: RuntimeQuestionRequest
  published?: RuntimeQuestionRequest
  signature?: string
  error?: Error
  listeners: Set<() => void>
  errors: Set<(error: Error) => void>
  generation: number
}

function project(request: OpenCodeQuestionRequest): RuntimeQuestionRequest {
  return {
    kind: "question",
    requestId: request.id,
    sessionId: request.sessionID,
    questions: request.questions.map((question) => ({
      header: question.header,
      prompt: question.question,
      options: question.options,
      multiple: question.multiple,
      custom: question.custom,
    })),
  }
}

/** Reconciles native list, runtime history, SSE and local responses per Session. */
export function createOpenCodeRuntimeInteractions(
  client: OpencodeClient,
  runtime?: OpenCodeInteractionSource,
  events?: EventSource,
  onLoadError?: (error: Error | undefined, threadId: string) => void
): RuntimeInteractionAdapter & { retry(threadId: string): void } {
  const sessions = new Map<string, SessionQuestions>()
  const session = (threadId: string) => {
    let value = sessions.get(threadId)
    if (!value) {
      value = {
        listed: [],
        loaded: false,
        resolved: new Set(),
        seen: new Map(),
        inFlight: new Set(),
        listeners: new Set(),
        errors: new Set(),
        generation: 0,
      }
      sessions.set(threadId, value)
    }
    return value
  }
  const getPending = (threadId: string) => {
    const current = session(threadId)
    const native = runtime?.read(threadId)
    const byId = new Map<string, OpenCodeQuestionRequest>()
    for (const question of [...current.listed, ...(native?.questions ?? [])]) {
      if (question.sessionID === threadId && !current.resolved.has(question.id))
        byId.set(question.id, question)
    }
    const questions = [...byId.values()].sort(
      (a, b) => a.askedAt - b.askedAt || a.id.localeCompare(b.id)
    )
    for (const question of questions)
      current.seen.set(question.id, project(question))
    const active =
      questions.find(({ id }) => id === current.snapshot?.requestId) ??
      questions[0]
    let request = current.expired ?? (active ? project(active) : undefined)
    if (!request && current.loaded && !current.error && native) {
      const orphan = findOrphanedOpenCodeQuestion(native.state)
      if (orphan)
        request = {
          ...project({
            id: orphan.callId,
            sessionID: threadId,
            askedAt: orphan.askedAt,
            questions: orphan.questions,
          }),
          status: "recovered",
        }
    }
    const signature = JSON.stringify(request)
    if (signature !== current.signature) {
      current.signature = signature
      current.snapshot = request
    }
    return current.snapshot
  }
  const notify = (threadId: string) => {
    const current = session(threadId)
    const previous = current.published
    const next = getPending(threadId)
    current.published = next
    if (next !== previous) for (const listener of current.listeners) listener()
  }
  const reload = async (threadId: string) => {
    const current = session(threadId)
    const generation = ++current.generation
    try {
      const response = await client.question.list(undefined, REQUEST_OPTIONS)
      if (generation !== current.generation || !current.listeners.size) return
      const now = Date.now()
      current.listed = (response.data ?? [])
        .filter((question) => question.sessionID === threadId)
        .map((question, index) => ({ ...question, askedAt: now + index }))
      current.loaded = true
      current.error = undefined
      onLoadError?.(undefined, threadId)
      // Tombstones remain until every native snapshot has observed removal.
      const ids = new Set(
        [...current.listed, ...(runtime?.read(threadId)?.questions ?? [])].map(
          ({ id }) => id
        )
      )
      for (const id of current.resolved)
        if (!ids.has(id)) current.resolved.delete(id)
      notify(threadId)
    } catch (reason) {
      if (generation !== current.generation || !current.listeners.size) return
      current.error =
        reason instanceof Error ? reason : new Error(String(reason))
      onLoadError?.(current.error, threadId)
      for (const onError of current.errors) onError(current.error)
      notify(threadId)
    }
  }
  const resolve = async (
    request: RuntimeQuestionRequest,
    action: () => Promise<unknown>
  ) => {
    const current = session(request.sessionId)
    current.inFlight.add(request.requestId)
    try {
      await action()
      current.resolved.add(request.requestId)
      current.seen.delete(request.requestId)
      notify(request.sessionId)
    } finally {
      current.inFlight.delete(request.requestId)
    }
  }
  return {
    getPending,
    retry: (threadId) => {
      void reload(threadId)
    },
    subscribe(threadId, listener, onError) {
      const current = session(threadId)
      if (!current.listeners.size) current.published = getPending(threadId)
      current.listeners.add(listener)
      if (onError) current.errors.add(onError)
      const source = events ?? new OpenCodeEventSource(client)
      const unsubscribe = source.subscribe((event) => {
        if (event.type === "stream.reconnected") {
          void reload(threadId)
          return
        }
        if (event.sessionId !== threadId) return
        if (event.type === "question.asked") {
          void reload(threadId)
          return
        }
        if (
          event.type !== "question.replied" &&
          event.type !== "question.rejected"
        )
          return
        const id = event.properties.requestID
        if (
          typeof id !== "string" ||
          current.inFlight.has(id) ||
          current.resolved.has(id)
        )
          return
        getPending(threadId)
        const pending = current.seen.get(id)
        current.resolved.add(id)
        current.seen.delete(id)
        if (pending) current.expired = { ...pending, status: "expired" }
        notify(threadId)
        void reload(threadId)
      })
      const unsubscribeRuntime = runtime?.subscribe(() => notify(threadId))
      void reload(threadId)
      return () => {
        unsubscribe()
        unsubscribeRuntime?.()
        if (!events) (source as OpenCodeEventSource).dispose()
        current.listeners.delete(listener)
        if (onError) current.errors.delete(onError)
        if (!current.listeners.size) current.generation++
      }
    },
    dismiss(request) {
      const current = session(request.sessionId)
      if (current.expired?.requestId !== request.requestId) return
      current.expired = undefined
      notify(request.sessionId)
    },
    async respond(request, response) {
      await resolve(request, () =>
        client.question.reply(
          { requestID: request.requestId, answers: response.answers },
          REQUEST_OPTIONS
        )
      )
    },
    async reject(request) {
      await resolve(request, () =>
        client.question.reject(
          { requestID: request.requestId },
          REQUEST_OPTIONS
        )
      )
    },
  }
}
