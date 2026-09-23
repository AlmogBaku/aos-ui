// @vitest-environment jsdom

import {
  AssistantRuntimeProvider,
  type AssistantRuntime,
} from "@assistant-ui/react"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { useFixtureComposerFeatures } from "./fixture-composer-features"
import { useFixtureRuntimeBundle } from "./fixture-runtime"

const allEnabled = {
  modelSelectorEnabled: true,
  contextEnabled: true,
}

describe("fixture composer features", () => {
  it("updates authoritative context from messages and the selected Session model", async () => {
    let runtime: AssistantRuntime | undefined
    let features: ComposerFeatureViewModel = {}
    const Harness = ({ threadId }: { threadId: string }) => {
      const bundle = useFixtureRuntimeBundle({ threadId, streamDelayMs: 0 })
      runtime = bundle.assistantRuntime
      features = useFixtureComposerFeatures({
        threadId,
        config: allEnabled,
        runtime,
      })
      return <AssistantRuntimeProvider runtime={runtime} />
    }
    const view = render(<Harness threadId="thread-aster-market" />)

    await waitFor(() =>
      expect(runtime?.threads.mainItem.getState().remoteId).toBe(
        "thread-aster-market"
      )
    )
    expect(features.model?.selectedId).toBe("fixture-balanced")
    expect(features.model?.options).toEqual([
      {
        id: "fixture-balanced",
        label: "Fixture Balanced",
        group: "Fixture",
        efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      },
      { id: "fixture-fast", label: "Fixture Fast", group: "Fixture" },
    ])
    expect(features.context).toMatchObject({
      usage: { system: 2, tools: 1, messages: 9, total: 66 },
    })
    expect(features.context?.lastTurn).toEqual({
      inputTokens: 12_480,
      outputTokens: 1_236,
      cachedReadTokens: 8_192,
      totalTokens: 13_716,
    })
    expect(features.context?.cost).toEqual({ amount: 0.42, currency: "USD" })
    expect(features.slashCommands).toEqual([
      { name: "help", description: "Show fixture runtime help" },
      { name: "status", description: "Show fixture Session status" },
    ])

    act(() => {
      runtime!.thread.append({
        role: "user",
        content: [{ type: "text", text: "Add current runtime context" }],
        startRun: false,
      })
    })
    await waitFor(() =>
      expect(features.context).toMatchObject({
        usage: { system: 2, tools: 1, messages: 10, total: 66 },
      })
    )

    await act(() => features.model!.update({ selectedId: "fixture-fast" }))
    expect(features.model?.selectedId).toBe("fixture-fast")
    expect(features.context).toMatchObject({
      usage: { system: 2, tools: 1, messages: 10, total: 33 },
    })

    view.rerender(<Harness threadId="thread-mica-quarterly" />)
    await waitFor(() =>
      expect(runtime?.threads.mainItem.getState().remoteId).toBe(
        "thread-mica-quarterly"
      )
    )
    expect(features.model?.selectedId).toBe("fixture-balanced")
    expect(features.context).toMatchObject({
      usage: { system: 2, tools: 1, messages: 1, total: 66 },
    })

    view.rerender(<Harness threadId="thread-aster-market" />)
    await waitFor(() =>
      expect(runtime?.threads.mainItem.getState().remoteId).toBe(
        "thread-aster-market"
      )
    )
    expect(features.model?.selectedId).toBe("fixture-fast")
    expect(features.context).toMatchObject({
      usage: { system: 2, tools: 1, messages: 10, total: 33 },
    })
  })

  it("reports each pick through the model feed the composer follows", async () => {
    const { result } = renderHook(() => {
      const bundle = useFixtureRuntimeBundle({
        threadId: "thread-aster-market",
        streamDelayMs: 0,
      })
      return useFixtureComposerFeatures({
        threadId: "thread-aster-market",
        config: allEnabled,
        runtime: bundle.assistantRuntime,
      })
    })
    const follow = result.current.model?.follow
    expect(follow?.current()).toEqual({
      selectedId: "fixture-balanced",
      effortId: "medium",
    })
    const first = follow?.current()
    expect(follow?.current()).toBe(first)

    let notified = 0
    const unsubscribe = follow!.subscribe(() => notified++)
    await act(() =>
      result.current.model!.update({ selectedId: "fixture-fast" })
    )
    unsubscribe()

    expect(notified).toBe(1)
    expect(follow?.current()).toEqual({
      selectedId: "fixture-fast",
      effortId: "medium",
    })
    expect(result.current.model?.selectedId).toBe("fixture-fast")
  })

  it("omits each disabled feature independently", () => {
    const { result, rerender } = renderHook(
      ({ config }) => {
        const bundle = useFixtureRuntimeBundle({
          threadId: "thread-aster-market",
          streamDelayMs: 0,
        })
        return useFixtureComposerFeatures({
          threadId: "thread-aster-market",
          config,
          runtime: bundle.assistantRuntime,
        })
      },
      {
        initialProps: {
          config: { modelSelectorEnabled: false, contextEnabled: true },
        },
      }
    )

    expect(result.current.model).toBeUndefined()
    expect(result.current.context).toBeDefined()

    rerender({
      config: { modelSelectorEnabled: true, contextEnabled: false },
    })
    expect(result.current.model).toBeDefined()
    expect(result.current.context).toBeUndefined()
  })
})
