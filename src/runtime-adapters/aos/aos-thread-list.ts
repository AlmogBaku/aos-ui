import {
  ExportedMessageRepository,
  type ChatModelRunResult,
  type RemoteThreadListAdapter,
  type ThreadAssistantMessagePart,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"

import {
  SESSION_CATALOG_MAX_WINDOW,
  type Session,
  type SessionMessage,
} from "../../../packages/protocol"
import type { AosRemoteClient } from "./aos-client"
import { AosDraftRegistry } from "./aos-drafts"
import {
  RESET_REQUIRED_CODE,
  runErrorText,
  type RunErrorResolver,
} from "./aos-reconnect"

const PAGE_SIZE = 50
type RemoteThreadMetadata = Awaited<
  ReturnType<RemoteThreadListAdapter["list"]>
>["threads"][number]

function metadata(session: Session): RemoteThreadMetadata {
  return {
    remoteId: session.id,
    externalId: session.id,
    status: session.archived ? "archived" : "regular",
    title: session.title,
    lastMessageAt: new Date(session.updatedAt),
    custom: { agentId: session.agentId, status: session.status },
  }
}

function cursorOffset(cursor: string | undefined) {
  if (cursor === undefined) return 0
  const match = /^aos-session-offset:([1-9]\d*)$/u.exec(cursor)
  if (!match) throw new Error("Invalid AOS Session cursor")
  const offset = Number(match[1])
  if (!Number.isSafeInteger(offset))
    throw new Error("Invalid AOS Session cursor")
  return offset
}

/** The normalized failure code a restored message carries, when it carries one. */
function runErrorCode(
  custom: NonNullable<SessionMessage["metadata"]>["custom"] | undefined
) {
  const aos = custom?.aos
  const code =
    typeof aos === "object" && aos !== null && !Array.isArray(aos)
      ? (aos as { runErrorCode?: unknown }).runErrorCode
      : undefined
  return typeof code === "string" ? code : undefined
}

type ResumedSegment =
  | { kind: "settled" }
  | { kind: "reset"; content: ThreadAssistantMessagePart[]; message?: string }

class AosThreadHistoryAdapter implements ThreadHistoryAdapter {
  #activeRunId?: string
  #activeFallback?: ThreadAssistantMessagePart[]
  constructor(
    private readonly client: AosRemoteClient,
    private readonly threadId: string,
    private readonly resolveRunError?: RunErrorResolver
  ) {}

  async load() {
    const history = await this.client.loadHistory(this.threadId)
    // An uncertain execution is projected as `failed` while it keeps its run
    // id: reconnecting with that id is exactly what reconciles it.
    this.#activeRunId =
      history.execution?.status === "running" ||
      history.execution?.status === "failed"
        ? history.execution.runId
        : undefined
    const messages = [...history.messages]
    const trailing = messages.at(-1)
    this.#activeFallback = undefined
    if (this.#activeRunId && trailing?.role === "assistant") {
      this.#activeFallback = trailing.content.map((part) => ({ ...part }))
      messages.pop()
    }
    const repository = ExportedMessageRepository.fromArray(
      messages.map((message): ThreadMessageLike => {
        const failure = this.#restoredFailure(message)
        return {
          ...message,
          ...(failure ? { status: failure } : {}),
          createdAt: new Date(message.createdAt),
        }
      })
    )
    return {
      ...repository,
      headId: repository.messages.at(-1)?.message.id ?? null,
      ...(this.#activeRunId ? { unstable_resume: true } : {}),
    }
  }

  /**
   * A restored failed turn carries the normalized code beside the proxy's own
   * description, so the workspace reads it exactly as it reads a live failure:
   * its own localized headline over the provider's own detail.
   */
  #restoredFailure(message: SessionMessage) {
    if (message.status?.type !== "incomplete") return undefined
    const code = runErrorCode(message.metadata?.custom)
    return {
      ...message.status,
      error: this.#error(
        { ...(code ? { code } : {}), message: message.status.error },
        message.status.error
      ),
    }
  }

  #error(event: { code?: string; message?: string }, fallback: string) {
    return runErrorText(
      this.resolveRunError,
      event.code,
      event.message ?? fallback
    )
  }

  async *resume(options: {
    abortSignal: AbortSignal
  }): AsyncGenerator<ChatModelRunResult> {
    const runId = this.#activeRunId
    if (!runId) return
    let after: number | undefined
    let reloaded = false
    // The authoritative prefix from the single reload. A later segment that
    // replays the turn itself supersedes it, so it is rendered only when a
    // reconnect settles without delivering any content.
    let reloadedContent: ThreadAssistantMessagePart[] = []
    while (true) {
      const segment = yield* this.#segment(runId, options.abortSignal, after)
      if (segment.kind === "settled") return
      if (reloaded) {
        yield {
          content: segment.content.length ? segment.content : reloadedContent,
          status: {
            type: "incomplete",
            reason: "error",
            error: segment.message ?? "AOS run history is unavailable",
          },
        }
        return
      }
      reloaded = true
      const history = await this.client.loadHistory(this.threadId)
      const assistant = history.messages.findLast(
        (message) => message.role === "assistant"
      )
      const fallback =
        assistant?.role === "assistant"
          ? assistant.content.map((part) => ({ ...part }))
          : (this.#activeFallback ?? segment.content)
      if (
        history.execution?.status === "waiting-for-input" &&
        assistant?.status?.type === "requires-action"
      ) {
        yield {
          content: fallback,
          status: assistant.status,
          metadata: assistant.metadata,
        }
        return
      }
      if (history.execution?.status === "idle") {
        yield {
          content: fallback,
          status: { type: "complete", reason: "stop" },
        }
        return
      }
      if (history.execution?.status !== "running") {
        yield {
          content: fallback,
          status: {
            type: "incomplete",
            reason: "error",
            error: segment.message ?? "AOS run history is unavailable",
          },
        }
        return
      }
      // The provider still reports this run, and an explicit cursor replays
      // the segment from its beginning. That replay carries the whole turn, so
      // the reloaded prefix is deliberately not seeded: it would be rendered
      // twice.
      reloadedContent = fallback
      after = 0
    }
  }

  async *#segment(
    runId: string,
    abortSignal: AbortSignal,
    after?: number
  ): AsyncGenerator<ChatModelRunResult, ResumedSegment> {
    const content: ThreadAssistantMessagePart[] = []
    const tools = new Map<string, number>()
    for await (const event of after === undefined
      ? this.client.reconnectRun(this.threadId, runId, abortSignal)
      : this.client.reconnectRun(this.threadId, runId, abortSignal, {
          after,
        })) {
      if (event.type === "TEXT_MESSAGE_CONTENT") {
        const last = content.at(-1)
        if (last?.type === "text")
          content[content.length - 1] = {
            ...last,
            text: last.text + event.delta,
          }
        else content.push({ type: "text", text: event.delta })
      } else if (event.type === "REASONING_MESSAGE_CONTENT") {
        const last = content.at(-1)
        if (last?.type === "reasoning")
          content[content.length - 1] = {
            ...last,
            text: last.text + event.delta,
          }
        else content.push({ type: "reasoning", text: event.delta })
      } else if (event.type === "TOOL_CALL_START") {
        tools.set(event.toolCallId, content.length)
        content.push({
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolCallName ?? "tool",
          args: {},
          argsText: "",
        })
      } else if (event.type === "TOOL_CALL_ARGS") {
        const index = tools.get(event.toolCallId)
        const part = index === undefined ? undefined : content[index]
        if (index !== undefined && part?.type === "tool-call")
          content[index] = { ...part, argsText: part.argsText + event.delta }
      } else if (event.type === "TOOL_CALL_RESULT") {
        const index = tools.get(event.toolCallId)
        const part = index === undefined ? undefined : content[index]
        if (index !== undefined && part?.type === "tool-call")
          content[index] = {
            ...part,
            result: event.content,
            ...(event.role === "tool" ? { isError: false } : {}),
          }
      }
      if (event.type === "RUN_ERROR") {
        if (event.code === RESET_REQUIRED_CODE)
          return {
            kind: "reset",
            content: [...content],
            message: this.#error(event, "AOS run history is unavailable"),
          }
        yield {
          content: [...content],
          status: {
            type: "incomplete",
            reason: "error",
            error: this.#error(event, "AOS run failed"),
          },
        }
        return { kind: "settled" }
      }
      if (event.type === "RUN_FINISHED") {
        if (event.outcome?.type === "interrupt") {
          yield {
            content: [...content],
            status: { type: "requires-action", reason: "interrupt" },
            metadata: {
              custom: { agui: { interrupts: event.outcome.interrupts } },
            },
          }
          return { kind: "settled" }
        }
        yield {
          content: [...content],
          status: { type: "complete", reason: "stop" },
        }
        return { kind: "settled" }
      }
      if (
        event.type === "TEXT_MESSAGE_CONTENT" ||
        event.type === "REASONING_MESSAGE_CONTENT" ||
        event.type === "TOOL_CALL_START" ||
        event.type === "TOOL_CALL_ARGS" ||
        event.type === "TOOL_CALL_RESULT"
      )
        yield { content: [...content], status: { type: "running" } }
    }
    return { kind: "settled" }
  }

  async append() {
    // The normalized AG-UI run endpoint owns durable writes.
  }
}

/** Public assistant-ui adapters over the normalized AOS REST surface. */
export class AosThreadListAdapter implements RemoteThreadListAdapter {
  readonly #histories = new Map<string, ThreadHistoryAdapter>()
  readonly #agents = new Map<string, string>()
  readonly #initializations = new Map<
    string,
    Promise<{ remoteId: string; externalId: string }>
  >()

  constructor(
    readonly client: AosRemoteClient,
    readonly drafts?: AosDraftRegistry,
    readonly resolveRunError?: RunErrorResolver
  ) {}

  async list({ after }: { after?: string } = {}) {
    const offset = cursorOffset(after)
    const page = await this.client.listSessionCatalog(PAGE_SIZE, offset)
    const sessions = [...page.sessions].sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.id.localeCompare(right.id)
    )
    const nextOffset = page.offset + page.sessions.length
    const hasMore =
      nextOffset < page.total && nextOffset < SESSION_CATALOG_MAX_WINDOW
    for (const session of sessions)
      this.#agents.set(session.id, session.agentId)
    return {
      threads: sessions.map(metadata),
      ...(hasMore
        ? {
            nextCursor: `aos-session-offset:${nextOffset}`,
          }
        : {}),
    }
  }

  async fetch(threadId: string) {
    const session = await this.client.getSession(threadId)
    this.#agents.set(session.id, session.agentId)
    return metadata(session)
  }

  async initialize(threadId: string) {
    const draftAgentId = this.drafts?.agentFor(threadId)
    if (draftAgentId) {
      let initialization = this.#initializations.get(threadId)
      if (!initialization) {
        initialization = this.client
          .createSession(draftAgentId)
          .then(({ threadId: remoteId }) => {
            this.#agents.set(remoteId, draftAgentId)
            return { remoteId, externalId: remoteId }
          })
          .finally(() => this.#initializations.delete(threadId))
        this.#initializations.set(threadId, initialization)
      }
      return initialization
    }
    const session = await this.fetch(threadId)
    return { remoteId: session.remoteId, externalId: session.externalId }
  }

  agentFor(threadId: string) {
    return this.#agents.get(threadId)
  }

  rename(threadId: string, title: string) {
    return this.client.renameSession(threadId, title)
  }

  archive(threadId: string) {
    return this.client.archiveSession(threadId)
  }

  unarchive(threadId: string) {
    return this.client.unarchiveSession(threadId)
  }

  delete(threadId: string) {
    return this.client.deleteSession(threadId)
  }

  async generateTitle(remoteId: string) {
    const client = this.client
    return new ReadableStream({
      async start(controller) {
        try {
          const session = await client.getSession(remoteId)
          const title = session.title.trim()
          if (title && title !== remoteId) {
            controller.enqueue({
              type: "part-start",
              path: [0],
              part: { type: "text" },
            })
            controller.enqueue({
              type: "text-delta",
              path: [0],
              textDelta: title,
            })
            controller.enqueue({ type: "part-finish", path: [0] })
          }
        } catch {
          // A later provider invalidation retries after Hermes persists a title.
        }
        controller.close()
      },
    }) as Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>
  }

  historyFor(threadId: string): ThreadHistoryAdapter {
    let history = this.#histories.get(threadId)
    if (!history) {
      history = new AosThreadHistoryAdapter(
        this.client,
        threadId,
        this.resolveRunError
      )
      this.#histories.set(threadId, history)
    }
    return history
  }
}
