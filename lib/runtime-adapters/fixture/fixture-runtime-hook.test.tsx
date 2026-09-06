// @vitest-environment jsdom

import {
  AssistantRuntimeProvider,
  type AssistantRuntime,
} from "@assistant-ui/react"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useFixtureRuntimeBundle } from "./fixture-runtime"
import { ActivityStore } from "../../notifications/store"
import { FIXTURE_NOW } from "./fixture-workspace"

describe("useFixtureRuntimeBundle", () => {
  it("keeps follow-ups parked when Escape cancels the active fixture run", async () => {
    let runtime: AssistantRuntime | undefined
    const Harness = () => {
      const bundle = useFixtureRuntimeBundle({
        threadId: "thread-aster-launch",
        onThreadIdChange: undefined,
        streamDelayMs: 1_000,
      })
      runtime = bundle.assistantRuntime
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          {null}
        </AssistantRuntimeProvider>
      )
    }

    render(<Harness />)
    await waitFor(() =>
      expect(runtime?.threads.mainItem.getState().remoteId).toBe(
        "thread-aster-launch"
      )
    )
    act(() => {
      runtime?.thread.append({
        role: "user",
        content: [{ type: "text", text: "Start a long fixture run" }],
      })
    })
    await waitFor(() => expect(runtime?.thread.getState().isRunning).toBe(true))
    act(() => {
      runtime?.thread.append({
        role: "user",
        content: [{ type: "text", text: "Keep this follow-up parked" }],
      })
    })
    await waitFor(() =>
      expect(runtime?.thread.composer.getState().queue).toHaveLength(1)
    )

    act(() => runtime?.thread.cancelRun())
    await waitFor(() =>
      expect(runtime?.thread.getState().isRunning).toBe(false)
    )
    expect(runtime?.thread.composer.getState().queue).toHaveLength(1)
  })

  it("controls the canonical Assistant UI thread from a provider Session id", async () => {
    const onThreadIdChange = vi.fn()
    let runtime: AssistantRuntime | undefined
    const Harness = ({ threadId }: { threadId: string }) => {
      const bundle = useFixtureRuntimeBundle({
        threadId,
        onThreadIdChange,
        streamDelayMs: 0,
      })
      runtime = bundle.assistantRuntime
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          {null}
        </AssistantRuntimeProvider>
      )
    }
    const { rerender } = render(<Harness threadId="thread-aster-market" />)

    await waitFor(() => {
      expect(runtime?.threads.mainItem.getState().remoteId).toBe(
        "thread-aster-market"
      )
    })

    rerender(<Harness threadId="thread-mica-quarterly" />)
    await waitFor(() => {
      expect(runtime?.threads.mainItem.getState().remoteId).toBe(
        "thread-mica-quarterly"
      )
    })
    expect(onThreadIdChange).not.toHaveBeenCalled()
  })

  it("keeps one workspace instance across renders", () => {
    const { result, rerender } = renderHook(
      ({ threadId }) => useFixtureRuntimeBundle({ threadId, streamDelayMs: 0 }),
      { initialProps: { threadId: "thread-aster-market" } }
    )
    const workspace = result.current.workspace
    rerender({ threadId: "thread-aster-launch" })
    expect(result.current.workspace).toBe(workspace)
  })

  it("resolves a question through the public runtime tool-result path", async () => {
    let bundle: ReturnType<typeof useFixtureRuntimeBundle> | undefined
    const Harness = () => {
      bundle = useFixtureRuntimeBundle({
        threadId: "thread-lumen-roadmap",
        streamDelayMs: 0,
      })
      return (
        <AssistantRuntimeProvider runtime={bundle.assistantRuntime}>
          {null}
        </AssistantRuntimeProvider>
      )
    }
    render(<Harness />)
    await waitFor(() =>
      expect(
        bundle?.assistantRuntime.threads.mainItem.getState().remoteId
      ).toBe("thread-lumen-roadmap")
    )
    const store = new ActivityStore({
      now: () => FIXTURE_NOW.getTime(),
      getThreadOwner: (threadId) =>
        threadId === "thread-lumen-roadmap" ? "agent-lumen" : undefined,
    })
    bundle!.workspace.subscribeActivity?.((event) =>
      store.ingest(event, {
        selection: null,
        pageVisible: false,
        pageFocused: false,
      })
    )

    act(() => {
      bundle!.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Ask a question" }],
      })
    })
    await waitFor(() =>
      expect(
        bundle!.assistantRuntime.thread.getState().messages.at(-1)?.status?.type
      ).toBe("requires-action")
    )
    const message = bundle!.assistantRuntime.thread.getState().messages.at(-1)
    const part = message?.content.find((item) => item.type === "tool-call")
    if (!message || !part || part.type !== "tool-call") {
      throw new Error("Expected fixture question tool call")
    }
    act(() => {
      bundle!.assistantRuntime.thread
        .getMessageById(message.id)
        .getMessagePartByToolCallId(part.toolCallId)
        .addToolResult({ answer: "Private answer" })
    })

    await waitFor(() =>
      expect(
        store.records().find((record) => record.type === "attention-requested")
          ?.resolved
      ).toBe(true)
    )
    expect(JSON.stringify(store.records())).not.toContain("Private answer")
    expect(
      bundle!.assistantRuntime.thread
        .getState()
        .messages.at(-1)
        ?.content.some(
          (item) =>
            item.type === "text" && item.text.includes("question response")
        )
    ).toBe(true)
  })
})
