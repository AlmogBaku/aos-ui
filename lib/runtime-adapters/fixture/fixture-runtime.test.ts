import {
  ExportedMessageRepository,
  type ChatModelRunOptions,
  type ChatModelRunResult,
} from "@assistant-ui/react"
import { describe, expect, it, vi } from "vitest"

import type { WorkspaceActivityEvent } from "../contracts"
import { ActivityStore } from "../../notifications/store"
import {
  createFixtureChatModel,
  createFixtureThreadListAdapter,
} from "./fixture-runtime"
import { AGENT_BUILDER_KICKOFF } from "../opencode/agent-draft"
import { FIXTURE_NOW, createFixtureWorkspace } from "./fixture-workspace"

function runOptions(
  prompt: string,
  threadId = "thread-aster-market",
  abortSignal = new AbortController().signal,
  assistantMessageId = "fixture-assistant-message"
) {
  const repository = ExportedMessageRepository.fromArray([
    {
      id: "fixture-user-prompt",
      role: "user",
      content: prompt,
      createdAt: FIXTURE_NOW,
    },
  ])

  return {
    messages: repository.messages.map(({ message }) => message),
    unstable_threadId: threadId,
    unstable_assistantMessageId: assistantMessageId,
    abortSignal,
    runConfig: {},
    context: {},
    unstable_getMessage: vi.fn(),
  } as unknown as ChatModelRunOptions
}

function resumedApprovalRunOptions(
  requestId: string,
  threadId = "thread-aster-market",
  assistantMessageId = "fixture-permission-response"
) {
  const repository = ExportedMessageRepository.fromArray([
    {
      id: "fixture-user-prompt",
      role: "user",
      content: "Request permission",
      createdAt: FIXTURE_NOW,
    },
    {
      id: "fixture-permission-response",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: requestId,
          toolName: "request_permission",
          args: { action: "Read the shared market dataset" },
          argsText: '{"action":"Read the shared market dataset"}',
          approval: {
            id: requestId,
            optionId: "always-dataset",
          },
        },
      ],
      createdAt: FIXTURE_NOW,
    },
  ])

  const messages = repository.messages.map(({ message }) => message)
  const currentMessage = messages.at(-1)

  return {
    ...runOptions(
      "Request permission",
      threadId,
      undefined,
      assistantMessageId
    ),
    messages: messages.slice(0, -1),
    unstable_getMessage: () => currentMessage,
  } as unknown as ChatModelRunOptions
}

function resumedQuestionRunOptions(
  requestId: string,
  threadId = "thread-lumen-roadmap",
  assistantMessageId = "fixture-question-response"
) {
  const repository = ExportedMessageRepository.fromArray([
    {
      id: "fixture-user-prompt",
      role: "user",
      content: "Ask a question",
      createdAt: FIXTURE_NOW,
    },
    {
      id: assistantMessageId,
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: requestId,
          toolName: "ask_user_question",
          args: { question: "Opaque" },
          argsText: '{"question":"Opaque"}',
          result: { answer: "private response" },
        },
      ],
      createdAt: FIXTURE_NOW,
    },
  ])
  const messages = repository.messages.map(({ message }) => message)
  return {
    ...runOptions("Ask a question", threadId, undefined, assistantMessageId),
    messages: messages.slice(0, -1),
    unstable_getMessage: () => messages.at(-1),
  } as unknown as ChatModelRunOptions
}

async function collectRun(
  run: Promise<ChatModelRunResult> | AsyncGenerator<ChatModelRunResult, void>
) {
  const updates: ChatModelRunResult[] = []
  if (Symbol.asyncIterator in run) {
    for await (const update of run) updates.push(update)
  } else {
    updates.push(await run)
  }
  return updates
}

describe("fixture Assistant UI thread adapter", () => {
  it("lists stable provider Sessions with authoritative Agent ownership", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const adapter = createFixtureThreadListAdapter(workspace)

    const result = await adapter.list()
    expect(result.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          remoteId: "thread-aster-market",
          title: "Market brief",
          custom: expect.objectContaining({ agentId: "agent-aster" }),
        }),
        expect.objectContaining({
          remoteId: "thread-mica-quarterly",
          custom: expect.objectContaining({ agentId: "agent-mica" }),
        }),
      ])
    )
  })

  it("loads each Session history independently, including an inline Plan", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const adapter = createFixtureThreadListAdapter(workspace)

    const market = await adapter.historyFor("thread-aster-market").load()
    const launch = await adapter.historyFor("thread-aster-launch").load()

    expect(
      market.messages.some(({ message }) =>
        message.content.some(
          (part) =>
            part.type === "tool-call" && part.toolName === "present_plan"
        )
      )
    ).toBe(true)
    expect(launch.messages).not.toEqual(market.messages)
  })

  it("includes a deterministic long-thread fixture for manual viewport traces", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const adapter = createFixtureThreadListAdapter(workspace)
    const history = await adapter.historyFor("thread-aster-interviews").load()

    expect(history.messages).toHaveLength(64)
    expect(history.messages[0]?.message.id).toBe("message-interviews-user-01")
    expect(history.messages.at(-1)?.message.id).toBe(
      "message-interviews-assistant-32"
    )
  })

  it("rejects fetching a deleted or unknown Session with a visible error source", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const adapter = createFixtureThreadListAdapter(workspace)
    await adapter.delete("thread-aster-launch")

    await expect(adapter.fetch("thread-aster-launch")).rejects.toThrow(
      "not found"
    )
    await expect(adapter.fetch("missing-thread")).rejects.toThrow("not found")
  })

  it("loads the exact Builder kickoff and its first typed question", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const adapter = createFixtureThreadListAdapter(workspace)
    const { threadId } = await workspace.openAgentBuilder()

    const history = await adapter.historyFor(threadId).load()

    expect(history.messages[0]?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: AGENT_BUILDER_KICKOFF }],
    })
    expect(history.messages[1]?.message.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-call",
          toolName: "ask_user_question",
        }),
      ])
    )
  })
})

describe("fixture ChatModelAdapter", () => {
  it("publishes a paired run lifecycle under the originating Session owner", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const activity: WorkspaceActivityEvent[] = []
    workspace.subscribeActivity((event) => activity.push(event))
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })

    await collectRun(
      model.run(
        runOptions("Give me the default brief", "thread-mica-quarterly")
      )
    )

    expect(activity).toEqual([
      {
        id: "fixture:runtime:thread-mica-quarterly:fixture-assistant-message:started",
        agentId: "agent-mica",
        threadId: "thread-mica-quarterly",
        occurredAt: FIXTURE_NOW.toISOString(),
        type: "run-started",
        lifecycleId:
          "fixture:runtime:thread-mica-quarterly:fixture-assistant-message",
      },
      {
        id: "fixture:runtime:thread-mica-quarterly:fixture-assistant-message:finished",
        agentId: "agent-mica",
        threadId: "thread-mica-quarterly",
        occurredAt: FIXTURE_NOW.toISOString(),
        type: "run-finished",
        lifecycleId:
          "fixture:runtime:thread-mica-quarterly:fixture-assistant-message",
      },
    ])
  })

  it("publishes a new lifecycle after workspace recreation and store hydration", async () => {
    const owner = (threadId: string) =>
      threadId === "thread-mica-quarterly" ? "agent-mica" : undefined
    const context = {
      selection: null,
      pageVisible: false,
      pageFocused: false,
    }
    const firstStore = new ActivityStore({
      now: () => FIXTURE_NOW.getTime(),
      getThreadOwner: owner,
    })
    const firstWorkspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    firstWorkspace.subscribeActivity((event) =>
      firstStore.ingest(event, context)
    )
    await collectRun(
      createFixtureChatModel(firstWorkspace, { streamDelayMs: 0 }).run(
        runOptions(
          "Give me the default brief",
          "thread-mica-quarterly",
          undefined,
          "provider-run-one"
        )
      )
    )

    const secondStore = new ActivityStore({
      now: () => FIXTURE_NOW.getTime(),
      getThreadOwner: owner,
    })
    secondStore.hydrate(firstStore.records())
    const secondWorkspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    secondWorkspace.subscribeActivity((event) =>
      secondStore.ingest(event, context)
    )
    await collectRun(
      createFixtureChatModel(secondWorkspace, { streamDelayMs: 0 }).run(
        runOptions(
          "Give me the default brief",
          "thread-mica-quarterly",
          undefined,
          "provider-run-two"
        )
      )
    )

    expect(
      secondStore
        .records()
        .flatMap((record) =>
          record.type === "run-finished" ? [record.lifecycleId] : []
        )
        .sort()
    ).toEqual([
      "fixture:runtime:thread-mica-quarterly:provider-run-one",
      "fixture:runtime:thread-mica-quarterly:provider-run-two",
    ])
  })

  it("closes a failed fixture run without exposing its error content", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const activity: WorkspaceActivityEvent[] = []
    workspace.subscribeActivity((event) => activity.push(event))
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })
    const run = model.run(
      runOptions("Simulate a provider outage", "thread-nori-copy")
    )

    await expect(collectRun(run)).rejects.toThrow(
      "Fixture provider unavailable"
    )
    expect(activity.map(({ type }) => type)).toEqual([
      "run-started",
      "run-failed",
    ])
    expect(activity[1]).toEqual({
      id: "fixture:runtime:thread-nori-copy:fixture-assistant-message:failed",
      agentId: "agent-nori",
      threadId: "thread-nori-copy",
      occurredAt: FIXTURE_NOW.toISOString(),
      type: "run-failed",
      lifecycleId: "fixture:runtime:thread-nori-copy:fixture-assistant-message",
    })
  })

  it("correlates repeated question and permission resolutions through ActivityStore", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const activity: WorkspaceActivityEvent[] = []
    const owners = new Map(
      workspace
        .listAllSessionMetadata()
        .map(({ threadId, agentId }) => [threadId, agentId])
    )
    const store = new ActivityStore({
      now: () => FIXTURE_NOW.getTime(),
      getThreadOwner: (threadId) => owners.get(threadId),
    })
    workspace.subscribeActivity((event) => {
      activity.push(event)
      store.ingest(event, {
        selection: null,
        pageVisible: false,
        pageFocused: false,
      })
    })
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })

    for (const suffix of ["one", "two"]) {
      await collectRun(
        model.run(
          runOptions(
            "Ask a question",
            "thread-lumen-roadmap",
            undefined,
            `question-${suffix}`
          )
        )
      )
      const question = activity.findLast(
        (event) =>
          event.type === "attention-requested" &&
          event.attentionKind === "question"
      )
      if (!question || question.type !== "attention-requested") {
        throw new Error("Expected question request")
      }
      await collectRun(
        model.run(
          resumedQuestionRunOptions(
            question.requestId,
            "thread-lumen-roadmap",
            `question-response-${suffix}`
          )
        )
      )

      await collectRun(
        model.run(
          runOptions(
            "Request permission",
            "thread-aster-launch",
            undefined,
            `permission-${suffix}`
          )
        )
      )
      const permission = activity.findLast(
        (event) =>
          event.type === "attention-requested" &&
          event.attentionKind === "permission"
      )
      if (!permission || permission.type !== "attention-requested") {
        throw new Error("Expected permission request")
      }
      await collectRun(
        model.run(
          resumedApprovalRunOptions(
            permission.requestId,
            "thread-aster-launch",
            `permission-response-${suffix}`
          )
        )
      )
    }

    const attention = store
      .records()
      .flatMap((record) =>
        record.type === "attention-requested" ? [record] : []
      )
    expect(attention).toHaveLength(4)
    expect(attention.every(({ resolved }) => resolved)).toBe(true)
    expect(new Set(attention.map(({ requestId }) => requestId)).size).toBe(4)
    expect(attention.map(({ attentionKind }) => attentionKind).sort()).toEqual([
      "permission",
      "permission",
      "question",
      "question",
    ])
    expect(JSON.stringify(activity)).not.toContain("private response")
  })

  it("does not infer a terminal outcome when a fixture run is cancelled", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const activity: WorkspaceActivityEvent[] = []
    workspace.subscribeActivity((event) => activity.push(event))
    const model = createFixtureChatModel(workspace, { streamDelayMs: 1_000 })
    const controller = new AbortController()
    const run = model.run(
      runOptions(
        "Show oversized Mermaid",
        "thread-mica-quarterly",
        controller.signal
      )
    )
    if (!(Symbol.asyncIterator in run)) throw new Error("Expected a stream")

    await run.next()
    controller.abort()
    await collectRun(run)

    expect(activity.map(({ type }) => type)).toEqual(["run-started"])
  })

  it("streams deterministic cumulative text", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })
    const updates = await collectRun(
      model.run(runOptions("Give me the default brief"))
    )

    expect(updates.length).toBeGreaterThan(1)
    expect(updates.at(-1)?.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Enterprise AI spend"),
    })
  })

  it("streams a Mermaid fence verbatim before completing it", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })
    const updates = await collectRun(model.run(runOptions("Show Mermaid")))

    expect(updates[0]?.content?.[0]).toEqual({
      type: "text",
      text: "```mermaid\n",
    })
    expect(updates.at(-1)?.content?.[0]).toEqual({
      type: "text",
      text: "```mermaid\nflowchart LR\n  Request --> Plan\n  Plan --> Result\n```",
    })
  })

  it("emits the oversized Mermaid boundary fixture in one update", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })
    const updates = await collectRun(
      model.run(runOptions("Show oversized Mermaid"))
    )

    expect(updates).toHaveLength(1)
    expect(updates[0]?.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("```mermaid"),
    })
  })

  it("publishes Todos only to the originating Session", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const originListener = vi.fn()
    const otherListener = vi.fn()
    workspace.subscribeTodos("thread-mica-quarterly", originListener)
    workspace.subscribeTodos("thread-aster-launch", otherListener)

    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })
    await collectRun(
      model.run(runOptions("Update the todo list", "thread-mica-quarterly"))
    )

    expect(originListener).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "todo-fixture-1" }),
    ])
    expect(otherListener).toHaveBeenCalledTimes(1)
  })

  it("keeps approval scenarios actionable until the user responds", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })
    const updates = await collectRun(
      model.run(runOptions("Request permission"))
    )

    expect(updates.at(-1)).toMatchObject({
      status: { type: "requires-action", reason: "tool-calls" },
      content: [
        expect.objectContaining({
          type: "tool-call",
          toolName: "request_permission",
          approval: expect.objectContaining({
            id: "fixture:permission:thread-aster-market:fixture-assistant-message",
          }),
        }),
      ],
    })
  })

  it("completes a resumed run without replaying a resolved approval tool call", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })
    const updates = await collectRun(
      model.run(
        resumedApprovalRunOptions(
          "fixture:permission:thread-aster-market:fixture-assistant-message"
        )
      )
    )

    expect(updates.at(-1)).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("permission decision"),
        },
      ],
    })
    expect(
      updates
        .flatMap((update) => update.content ?? [])
        .some(
          (part) =>
            part.type === "tool-call" &&
            part.toolCallId === "fixture-request_permission"
        )
    ).toBe(false)
  })

  it("preserves streamed partial content before a provider outage surfaces", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const model = createFixtureChatModel(workspace, { streamDelayMs: 0 })
    const run = model.run(runOptions("Simulate a provider outage"))
    const updates: ChatModelRunResult[] = []

    await expect(async () => {
      if (!(Symbol.asyncIterator in run)) throw new Error("Expected a stream")
      for await (const update of run) updates.push(update)
    }).rejects.toThrow("Fixture provider unavailable")

    expect(updates.at(-1)?.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("partial response"),
    })
  })
})
