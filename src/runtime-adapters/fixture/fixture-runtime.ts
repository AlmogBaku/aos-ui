"use client"

import {
  ExportedMessageRepository,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ChatModelRunResult,
  type ExportedMessageRepositoryItem,
  type RemoteThreadListAdapter,
  type RuntimeAdapters,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
  useAui,
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"
import { useMemo, useState } from "react"

import type { RuntimeQuestionRequest } from "@/runtime-adapters/contracts"
import { buildFixtureScenario } from "./fixture-scenarios"
import { createFixtureInteractions } from "./fixture-interactions"
import { createFixtureMcpAppAdapter } from "./fixture-mcp-apps"
import { fixturePresentationPart } from "./fixture-presentations"
import {
  FIXTURE_NOW,
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "./fixture-workspace"
import {
  createFixtureArtifactAdapter,
  FIXTURE_ARTIFACT_CATALOG,
} from "./fixture-artifacts"
import { fixtureSlashCommand } from "./fixture-slash-commands"

const fixtureAttachmentAdapter = new CompositeAttachmentAdapter([
  new SimpleImageAttachmentAdapter(),
  new SimpleTextAttachmentAdapter(),
])

const cloneRepository = (
  repository: ReturnType<typeof ExportedMessageRepository.fromArray>
) => structuredClone(repository)

function messagesFor(threadId: string): readonly ThreadMessageLike[] {
  if (threadId === "thread-aster-market") {
    return [
      {
        id: "message-market-user",
        role: "user",
        content:
          "Prepare my Q1 planning brief. Show where enterprise AI investment is shifting and tell me what to fund next.",
        createdAt: new Date("2026-09-03T09:10:00.000Z"),
      },
      {
        id: "message-market-assistant",
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "I’ll inspect the planning dataset, load the market-analysis workflow, and validate the investment signals before making a recommendation.",
          },
          {
            type: "tool-call",
            toolCallId: "fixture-initial-read-file",
            toolName: "read_file",
            args: { path: "planning-dataset-q1.md" },
            argsText: '{"path":"planning-dataset-q1.md"}',
            result: "Loaded the four-quarter planning dataset.",
          },
          {
            type: "tool-call",
            toolCallId: "fixture-initial-skill",
            toolName: "use_skill",
            args: { skill: "market-analysis" },
            argsText: '{"skill":"market-analysis"}',
            result:
              "Internal fixture instructions intentionally hidden from the message UI.",
          },
          {
            type: "tool-call",
            toolCallId: "fixture-initial-search",
            toolName: "web_search",
            args: { query: "enterprise AI investment Q1" },
            argsText: '{"query":"enterprise AI investment Q1"}',
            result: "Found four relevant planning sections.",
          },
          {
            type: "reasoning",
            text: "The applied-AI series is accelerating faster than the platform baseline, while governance is rising steadily. I’ll run the comparison and capture the recommendation with its supporting visual.",
          },
          {
            type: "tool-call",
            toolCallId: "fixture-initial-terminal",
            toolName: "terminal",
            args: { command: "bun run analyze:market" },
            argsText: '{"command":"bun run analyze:market"}',
            result: { output: "Analysis complete", exitCode: 0 },
          },
          {
            type: "tool-call",
            toolCallId: "fixture-initial-edit",
            toolName: "apply_patch",
            args: { path: "enterprise-ai-brief.md" },
            argsText: '{"path":"enterprise-ai-brief.md"}',
            result: { file: "enterprise-ai-brief.md", added: 18, removed: 3 },
          },
          {
            type: "tool-call",
            toolCallId: "fixture-initial-subagent",
            toolName: "delegate_subagent",
            args: { task: "Validate the market segments" },
            argsText: '{"task":"Validate the market segments"}',
            result: {
              name: "Market research analyst",
              status: "completed",
              summary:
                "Validated the segment definitions and four-quarter trend.",
            },
          },
          fixturePresentationPart("fixture-initial-chart"),
          {
            type: "source",
            sourceType: "url",
            id: "fixture-market-source",
            title: "Planning dataset methodology",
            url: "https://example.com/planning-dataset-methodology",
          },
          {
            type: "data",
            name: "aos.artifact",
            data: FIXTURE_ARTIFACT_CATALOG.examples.markdown,
          },
          {
            type: "text",
            text: "**Recommendation:** prioritize applied AI workflows, while funding platform and governance foundations together.\n\nApplied AI is accelerating fastest in the planning dataset. Governance is also becoming a material budget line instead of a later-stage add-on. Values are illustrative indices, not market estimates.",
          },
        ],
        createdAt: new Date("2026-09-03T09:12:00.000Z"),
        // A real turn always arrives with the span the wire reported, and the
        // preview says how long this one worked rather than only that it did.
        metadata: {
          timing: {
            streamStartTime: Date.parse("2026-09-03T09:11:31.000Z"),
            totalStreamTime: 29_000,
            totalChunks: 48,
            toolCallCount: 7,
          },
        },
      },
    ]
  }

  if (threadId === "thread-aster-interviews") {
    return Array.from({ length: 32 }, (_, index) => {
      const turn = String(index + 1).padStart(2, "0")
      const createdAt = new Date(
        Date.parse("2026-09-02T08:00:00.000Z") + index * 60_000
      )
      return [
        {
          id: `message-interviews-user-${turn}`,
          role: "user" as const,
          content: `Interview theme ${index + 1}: what changed in the customer workflow?`,
          createdAt,
        },
        {
          id: `message-interviews-assistant-${turn}`,
          role: "assistant" as const,
          content:
            "The signal is consistent: teams value a clear handoff, visible ownership, and fewer context switches. This evidence remains attached to the interview Session.",
          createdAt,
        },
      ]
    }).flat()
  }

  const titleByThread: Record<string, string> = {
    "thread-aster-launch":
      "Review the launch narrative and identify the most important decision.",
    "thread-aster-scan":
      "Summarize the competitive scan without overloading the brief.",
    "thread-aster-pricing":
      "Compare the pricing signals from the current dataset.",
    "thread-mica-quarterly": "Prepare the quarterly synthesis.",
    "thread-lumen-roadmap": "Review the roadmap and ask for missing input.",
    "thread-vela-metrics": "Interpret the activation metrics.",
    "thread-nori-copy": "Polish the launch copy.",
  }
  const prompt = titleByThread[threadId]
  if (!prompt) return []

  return [
    {
      id: `${threadId}-user`,
      role: "user",
      content: prompt,
      createdAt: FIXTURE_NOW,
    },
    {
      id: `${threadId}-assistant`,
      role: "assistant",
      content:
        threadId === "thread-lumen-roadmap"
          ? "I’ve reviewed the available roadmap. Which customer segment should define the first release?"
          : threadId === "thread-aster-launch"
            ? "I’m reviewing the launch goals, audience, narrative, and risks before recommending the decision that needs executive attention."
            : "The Session is ready to continue. The existing context remains scoped to this Agent.",
      createdAt: FIXTURE_NOW,
    },
  ]
}

type FixtureMessagesForThread = (
  threadId: string
) => readonly ThreadMessageLike[]

class FixtureHistoryStore {
  readonly #repositories = new Map<
    string,
    ReturnType<typeof ExportedMessageRepository.fromArray>
  >()

  constructor(
    private readonly workspace: FixtureWorkspace,
    private readonly messagesForThread: FixtureMessagesForThread = messagesFor
  ) {}

  load(threadId: string) {
    const existing = this.#repositories.get(threadId)
    if (existing) return cloneRepository(existing)
    const seeded = ExportedMessageRepository.fromArray(
      this.messagesForThread(threadId)
    )
    this.#repositories.set(threadId, seeded)
    return cloneRepository(seeded)
  }

  upsert(threadId: string, item: ExportedMessageRepositoryItem) {
    const repository = this.load(threadId)
    const index = repository.messages.findIndex(
      ({ message }) => message.id === item.message.id
    )
    if (index >= 0) repository.messages[index] = item
    else repository.messages.push(item)
    repository.headId = item.message.id
    this.#repositories.set(threadId, cloneRepository(repository))
  }

  delete(threadId: string, items: ExportedMessageRepositoryItem[]) {
    const ids = new Set(items.map(({ message }) => message.id))
    const repository = this.load(threadId)
    repository.messages = repository.messages.filter(
      ({ message }) => !ids.has(message.id)
    )
    if (repository.headId && ids.has(repository.headId)) {
      repository.headId = repository.messages.at(-1)?.message.id ?? null
    }
    this.#repositories.set(threadId, cloneRepository(repository))
  }
}

class FixtureHistoryAdapter implements ThreadHistoryAdapter {
  constructor(
    private readonly store: FixtureHistoryStore,
    private readonly resolveThreadId: () =>
      string | undefined | Promise<string | undefined>
  ) {}

  async #threadId() {
    const threadId = await this.resolveThreadId()
    if (!threadId) throw new Error("Fixture Session is not initialized")
    return threadId
  }

  async load() {
    const threadId = await this.resolveThreadId()
    return threadId ? this.store.load(threadId) : { messages: [] }
  }

  async append(item: ExportedMessageRepositoryItem) {
    this.store.upsert(await this.#threadId(), item)
  }

  async update(item: ExportedMessageRepositoryItem) {
    this.store.upsert(await this.#threadId(), item)
  }

  async delete(items: ExportedMessageRepositoryItem[]) {
    this.store.delete(await this.#threadId(), items)
  }
}

export class FixtureThreadListAdapter implements RemoteThreadListAdapter {
  unstable_useAdapters?: () => RuntimeAdapters
  readonly #history: FixtureHistoryStore

  constructor(
    readonly workspace: FixtureWorkspace,
    messagesForThread?: FixtureMessagesForThread
  ) {
    this.#history = new FixtureHistoryStore(workspace, messagesForThread)
  }

  historyFor(threadId: string): ThreadHistoryAdapter {
    return new FixtureHistoryAdapter(this.#history, () => threadId)
  }

  dynamicHistory(
    resolveThreadId: () => string | undefined | Promise<string | undefined>
  ) {
    return new FixtureHistoryAdapter(this.#history, resolveThreadId)
  }

  async list() {
    return {
      threads: this.workspace
        .listAllSessionMetadata()
        .map(({ threadId, agentId, updatedAt, status, archived }) => ({
          remoteId: threadId,
          externalId: threadId,
          status: archived ? ("archived" as const) : ("regular" as const),
          title: this.workspace.getSessionTitle(threadId),
          lastMessageAt: new Date(updatedAt),
          custom: { agentId, status },
        })),
    }
  }

  async rename(remoteId: string, newTitle: string) {
    this.workspace.setSessionTitle(remoteId, newTitle)
  }

  async updateCustom() {}

  async archive(remoteId: string) {
    await this.assertSession(remoteId)
    this.workspace.setSessionArchived(remoteId, true)
  }

  async unarchive(remoteId: string) {
    await this.assertSession(remoteId)
    this.workspace.setSessionArchived(remoteId, false)
  }

  async delete(remoteId: string) {
    await this.assertSession(remoteId)
    this.workspace.deleteSession(remoteId)
  }

  async initialize(threadId: string) {
    await this.assertSession(threadId)
    return { remoteId: threadId, externalId: threadId }
  }

  async generateTitle() {
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    }) as Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>
  }

  async fetch(threadId: string) {
    const session = await this.assertSession(threadId)
    return {
      remoteId: session.threadId,
      externalId: session.threadId,
      status: session.archived ? ("archived" as const) : ("regular" as const),
      title: this.workspace.getSessionTitle(threadId),
      lastMessageAt: new Date(session.updatedAt),
      custom: { agentId: session.agentId, status: session.status },
    }
  }

  private async assertSession(threadId: string) {
    const [session] = await this.workspace.getSessionMetadata([threadId])
    if (!session) throw new Error(`Fixture Session not found: ${threadId}`)
    return session
  }
}

function useFixtureThreadAdapters(
  adapter: FixtureThreadListAdapter
): RuntimeAdapters {
  const aui = useAui()
  const history = useMemo(
    () =>
      adapter.dynamicHistory(() => {
        const state = aui.threadListItem.getState()
        return state.remoteId
      }),
    [adapter, aui]
  )
  return useMemo(() => ({ history }), [history])
}

export function createFixtureThreadListAdapter(
  workspace: FixtureWorkspace,
  messagesForThread?: FixtureMessagesForThread
) {
  const adapter = new FixtureThreadListAdapter(workspace, messagesForThread)
  adapter.unstable_useAdapters = function useFixtureAdapters() {
    return useFixtureThreadAdapters(adapter)
  }
  return adapter
}

function latestUserMessage({ messages }: ChatModelRunOptions) {
  return [...messages].reverse().find(({ role }) => role === "user")
}

function latestUserText(options: ChatModelRunOptions) {
  const message = latestUserMessage(options)
  if (!message) return ""
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function resolvedAttention(options: ChatModelRunOptions) {
  const current = options.unstable_getMessage()
  const latestUserIndex = options.messages.findLastIndex(
    ({ role }) => role === "user"
  )
  const messages = [
    ...options.messages.slice(latestUserIndex + 1),
    ...(current ? [current] : []),
  ]
  for (const message of messages.toReversed()) {
    if (message.role !== "assistant") continue
    for (const part of message.content.toReversed()) {
      if (part.type !== "tool-call") continue
      if (part.toolName === "ask_user_question" && part.result !== undefined) {
        return { kind: "question" as const, requestId: part.toolCallId }
      }
      if (
        part.toolName === "request_permission" &&
        part.approval !== undefined &&
        (part.approval.approved !== undefined ||
          part.approval.optionId !== undefined ||
          part.approval.text !== undefined ||
          part.approval.resolution !== undefined)
      ) {
        return {
          kind: "permission" as const,
          requestId: part.approval.id,
        }
      }
    }
  }
  return undefined
}

function waitForChunk(delayMs: number, signal: AbortSignal) {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, delayMs)
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
  })
}

/** Stream ticks between two frames of a streamed tool snapshot. */
const FRAME_TICKS = 20

export function createFixtureChatModel(
  workspace: FixtureWorkspace,
  {
    streamDelayMs = 22,
    onQuestion,
  }: {
    streamDelayMs?: number
    onQuestion?: (threadId: string, request: RuntimeQuestionRequest) => void
  } = {}
): ChatModelAdapter {
  return {
    async *run(options): AsyncGenerator<ChatModelRunResult, void> {
      const userText = latestUserText(options)
      const scenario = buildFixtureScenario(userText)
      const threadId = options.unstable_threadId
      const activity = threadId
        ? workspace.beginRunActivity(
            threadId,
            options.unstable_assistantMessageId
          )
        : undefined

      try {
        const commandOutput = fixtureSlashCommand(userText)
        if (commandOutput !== undefined) {
          yield { content: [{ type: "text", text: commandOutput }] }
          workspace.finishRunActivity(activity, "finished")
          return
        }
        const resolution = resolvedAttention(options)
        if (resolution) {
          if (threadId) {
            workspace.publishAttention(
              threadId,
              "resolved",
              resolution.requestId
            )
          }
          yield {
            content: [
              {
                type: "text",
                text:
                  resolution.kind === "question"
                    ? "Your provider recorded the question response."
                    : "Your provider recorded the permission decision.",
              },
            ],
          }
          if (options.abortSignal.aborted) return
          workspace.finishRunActivity(activity, "finished")
          return
        }

        if (threadId && scenario.todoEvent) {
          workspace.emitTodos(threadId, scenario.todoEvent)
        }
        let scenarioParts = scenario.parts
        if (
          threadId &&
          (scenario.name === "question" || scenario.name === "permission")
        ) {
          const kind = scenario.name
          const requestId = workspace.createAttentionRequestId(
            threadId,
            kind,
            options.unstable_assistantMessageId
          )
          workspace.publishAttention(threadId, kind, requestId)
          if (kind === "question" && scenario.questionTemplate) {
            const {
              prompt,
              options: opts,
              allowFreeform,
            } = scenario.questionTemplate
            onQuestion?.(threadId, {
              kind: "question",
              requestId,
              sessionId: threadId,
              questions: [
                {
                  prompt,
                  options: opts.map((label) => ({ label })),
                  custom: allowFreeform,
                },
              ],
            })
          }
          scenarioParts = scenario.parts.map((part) =>
            part.type !== "tool-call"
              ? part
              : kind === "question"
                ? { ...part, toolCallId: requestId }
                : {
                    ...part,
                    toolCallId: requestId,
                    approval: part.approval
                      ? { ...part.approval, id: requestId }
                      : part.approval,
                  }
          )
        }

        const textPart =
          scenarioParts.length === 1 && scenarioParts[0]?.type === "text"
            ? scenarioParts[0]
            : undefined

        if (textPart) {
          const chunks =
            scenario.name === "mermaid-oversized"
              ? [textPart.text]
              : textPart.text.split(/(?<=\s)/u)
          let text = ""
          for (const chunk of chunks) {
            if (options.abortSignal.aborted) return
            text += chunk
            yield { content: [{ type: "text", text }] }
            await waitForChunk(streamDelayMs, options.abortSignal)
          }
        } else {
          for (const frame of scenario.frames ?? []) {
            if (options.abortSignal.aborted) return
            yield { content: frame }
            await waitForChunk(streamDelayMs * FRAME_TICKS, options.abortSignal)
          }
          if (options.abortSignal.aborted) return
          const requiresAction = scenarioParts.some(
            (part) =>
              part.type === "tool-call" &&
              ((part.toolName === "ask_user_question" &&
                part.result === undefined) ||
                (part.approval !== undefined &&
                  part.approval.resolution === undefined &&
                  part.approval.approved === undefined &&
                  part.approval.optionId === undefined &&
                  part.approval.text === undefined))
          )
          yield {
            content: scenarioParts,
            ...(requiresAction
              ? {
                  status: {
                    type: "requires-action" as const,
                    reason: "tool-calls" as const,
                  },
                }
              : {}),
          }
        }

        if (options.abortSignal.aborted) return
        if (scenario.status) yield { status: scenario.status }
        if (scenario.outage) throw scenario.outage
        workspace.finishRunActivity(
          activity,
          scenario.status?.type === "incomplete" &&
            scenario.status.reason === "error"
            ? "failed"
            : "finished"
        )
      } catch (reason) {
        workspace.finishRunActivity(activity, "failed")
        throw reason
      }
    },
  }
}

export type FixtureRuntimeBundleOptions = {
  threadId?: string
  onThreadIdChange?: (threadId: string | undefined) => void
  streamDelayMs?: number
  enableAgentCreator?: boolean
  /** Test-only seed overrides keep component tests independent of demo copy. */
  testOnly?: {
    workspace?: FixtureWorkspace
    messagesForThread?: FixtureMessagesForThread
  }
}

export function useFixtureRuntimeBundle({
  threadId,
  onThreadIdChange,
  streamDelayMs,
  enableAgentCreator,
  testOnly,
}: FixtureRuntimeBundleOptions = {}) {
  const [workspace] = useState(
    () =>
      testOnly?.workspace ??
      createFixtureWorkspace({
        clock: () => FIXTURE_NOW,
        enableAgentCreator,
      })
  )
  const threadListAdapter = useMemo(
    () =>
      createFixtureThreadListAdapter(workspace, testOnly?.messagesForThread),
    [testOnly?.messagesForThread, workspace]
  )
  const artifacts = useMemo(() => createFixtureArtifactAdapter(), [])
  const interactions = useMemo(() => createFixtureInteractions(), [])
  const mcpApps = useMemo(() => createFixtureMcpAppAdapter(), [])
  const chatModel = useMemo(
    () =>
      createFixtureChatModel(workspace, {
        streamDelayMs,
        onQuestion: (threadId, request) => interactions.register(request),
      }),
    [streamDelayMs, workspace, interactions]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: threadListAdapter,
    threadId,
    onThreadIdChange,
    allowNesting: true,
    runtimeHook: function useFixtureThreadRuntime() {
      return useLocalRuntime(chatModel, {
        maxSteps: 5,
        unstable_enableMessageQueue: true,
        unstable_queueClearOnCancel: false,
        unstable_humanToolNames: ["ask_user_question"],
        adapters: { attachments: fixtureAttachmentAdapter },
      })
    },
  })

  return useMemo(
    () => ({ assistantRuntime, workspace, artifacts, interactions, mcpApps }),
    [artifacts, assistantRuntime, workspace, interactions, mcpApps]
  )
}
