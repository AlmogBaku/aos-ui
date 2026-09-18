import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { AosWorkspaceCapabilities } from "./aos-client"
import {
  useAosComposerFeatures,
  useAosSessionCapabilities,
  useAosSlashCommands,
} from "./aos-composer-features"

function capabilities(): AosWorkspaceCapabilities {
  return {
    agent: {
      transport: { streaming: true, resumable: true },
      reasoning: { supported: true, streaming: true },
      multimodal: {
        input: { image: true, audio: false, file: true },
        output: { audio: false },
      },
      humanInTheLoop: {
        supported: true,
        approvals: true,
        interrupts: true,
      },
    },
    workspace: {
      slashCommands: {
        status: "available",
        scope: "attached-session",
        commands: [{ name: "help" }],
      },
      models: {
        status: "available",
        scope: "attached-session",
        selection: "native-session",
        choices: "provider-reported",
      },
      context: {
        status: "available",
        scope: "attached-session",
        source: "provider-usage-or-estimate",
        breakdown: "provider-categories",
      },
      todos: { status: "unavailable", reason: "history-unavailable" },
      activity: { status: "unavailable", reason: "session-info-unavailable" },
    },
    interactions: {
      steering: {
        status: "available",
        scope: "active-run",
        semantics: "visible-user-message",
        input: "text",
        fallback: "provider-queue",
      },
      approvals: {
        status: "available",
        protocol: "ag-ui-interrupt",
        scope: "run",
        choices: [
          { value: "once", scope: "request" },
          { value: "session", scope: "session" },
          { value: "always", scope: "agent" },
          { value: "deny", scope: "request" },
        ],
        maxPending: 64,
      },
      questions: {
        status: "available",
        protocol: "ag-ui-interrupt",
        scope: "run",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-empty-answer",
        maxQuestions: 32,
        maxChoicesPerQuestion: 64,
        maxAnswerValuesPerQuestion: 64,
        maxStringBytes: 4096,
      },
      reactions: { status: "unavailable", reason: "not-supported" },
    },
    content: {
      attachments: {
        status: "available",
        scope: "attached-session",
        inputs: ["image", "file"],
        imageMimeTypes: ["image/png"],
        fileMimeTypes: "valid-type/subtype",
        maxMimeTypeBytes: 256,
        maxFilenameBytes: 255,
        maxCount: 16,
        maxImageBytes: 1,
        maxFileBytes: 1,
        maxTotalBytes: 1,
      },
      artifacts: { status: "unavailable", reason: "not-supported" },
      transcription: { status: "unavailable", reason: "not-supported" },
      speech: { status: "unavailable", reason: "not-supported" },
    },
  }
}

describe("AOS composer features", () => {
  it("guest completion is hidden until explicitly enabled while operator defaults to enabled", async () => {
    const guest = renderHook(
      ({ enabled }) => useAosSlashCommands(capabilities(), enabled),
      { initialProps: { enabled: false } }
    )
    expect(guest.result.current).toBeUndefined()
    guest.rerender({ enabled: true })
    expect(guest.result.current).toEqual([{ name: "help" }])
    guest.unmount()
    const operator = renderHook(() => useAosSlashCommands(capabilities()))
    expect(operator.result.current).toEqual([{ name: "help" }])
  })

  it("an unavailable catalog leaves an empty completion list", () => {
    const unavailable = capabilities()
    unavailable.workspace.slashCommands = {
      status: "unavailable",
      reason: "command-catalog-unavailable",
    }
    const { result } = renderHook(() => useAosSlashCommands(unavailable))
    expect(result.current).toEqual([])
  })
  it("reads the selected Session capability projection even when presentation policy hides composer features", async () => {
    const workspaceCapabilities = vi.fn(async () => capabilities())
    const models = vi.fn()
    const context = vi.fn()
    const client = {
      workspaceCapabilities,
      models,
      context,
      selectModel: vi.fn(),
      selectEffort: vi.fn(),
      steerRun: vi.fn(),
    }

    renderHook(() => useAosSessionCapabilities(client, "session-1"))

    await waitFor(() =>
      expect(workspaceCapabilities).toHaveBeenCalledWith("session-1")
    )
    expect(models).not.toHaveBeenCalled()
    expect(context).not.toHaveBeenCalled()
  })

  it("does not refetch capabilities for a generic Session invalidation or rerender", async () => {
    const workspaceCapabilities = vi.fn(async () => capabilities())
    let invalidate: (() => void) | undefined
    const client = {
      workspaceCapabilities,
      subscribeSessionInvalidation: vi.fn(
        (_threadId: string, listener: () => void) => {
          invalidate = listener
          return () => undefined
        }
      ),
    }
    const { rerender } = renderHook(
      ({ threadId }) => useAosSessionCapabilities(client, threadId),
      { initialProps: { threadId: "session-1" } }
    )

    await waitFor(() => expect(workspaceCapabilities).toHaveBeenCalledOnce())
    invalidate?.()
    rerender({ threadId: "session-1" })
    await Promise.resolve()

    expect(workspaceCapabilities).toHaveBeenCalledOnce()
    expect(client.subscribeSessionInvalidation).not.toHaveBeenCalled()
  })

  it("projects normalized selected model and context for only the selected Session", async () => {
    const models = vi.fn(async () => ({
      selectedId: "small",
      options: [{ id: "small", label: "Small", group: "Native" }],
    }))
    const context = vi.fn(async () => ({
      usedTokens: 1_200,
      maxTokens: 8_000,
      source: "provider-usage" as const,
      breakdown: { systemTokens: 100, toolTokens: 200, messageTokens: 900 },
    }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context,
      selectModel: vi.fn(),
      selectEffort: vi.fn(),
      steerRun: vi.fn(),
    }
    const { result } = renderHook(() => {
      const sessionCapabilities = useAosSessionCapabilities(client, "session-1")
      return useAosComposerFeatures(
        client,
        {
          modelSelectorEnabled: true,
          contextEnabled: true,
        },
        "session-1",
        sessionCapabilities
      )
    })

    await waitFor(() => expect(result.current.model?.selectedId).toBe("small"))
    expect(result.current.context?.usage).toEqual({
      system: 0,
      tools: 0,
      messages: 1,
      total: 8,
    })
    expect(models).toHaveBeenCalledWith("session-1")
    expect(context).toHaveBeenCalledWith("session-1")
  })

  it("projects effortId and selectEffort when selected option has efforts", async () => {
    const models = vi.fn(async () => ({
      selectedId: "a",
      effortId: "medium",
      options: [
        { id: "a", label: "A", group: "G", efforts: ["low", "medium", "high"] },
      ],
    }))
    const selectEffortMock = vi.fn(async () => ({ effortId: "high" }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      selectModel: vi.fn(),
      selectEffort: selectEffortMock,
      steerRun: vi.fn(),
    }
    const onError = vi.fn()
    const { result } = renderHook(() => {
      const sessionCapabilities = useAosSessionCapabilities(client, "session-1")
      return useAosComposerFeatures(
        client,
        { modelSelectorEnabled: true, contextEnabled: false },
        "session-1",
        sessionCapabilities,
        onError
      )
    })

    await waitFor(() => expect(result.current.model?.effortId).toBe("medium"))
    expect(result.current.model?.selectEffort).toBeDefined()

    await result.current.model?.selectEffort?.("high")
    expect(selectEffortMock).toHaveBeenCalledWith("session-1", "high")
    await waitFor(() => expect(result.current.model?.effortId).toBe("high"))
  })

  it("sets effortSelection to error and calls onError when selectEffort rejects", async () => {
    const models = vi.fn(async () => ({
      selectedId: "a",
      effortId: "medium",
      options: [
        { id: "a", label: "A", group: "G", efforts: ["low", "medium", "high"] },
      ],
    }))
    const failure = new Error("effort-fail")
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      selectModel: vi.fn(),
      selectEffort: vi.fn(async () => {
        throw failure
      }),
      steerRun: vi.fn(),
    }
    const onError = vi.fn()
    const { result } = renderHook(() => {
      const sessionCapabilities = useAosSessionCapabilities(client, "session-1")
      return useAosComposerFeatures(
        client,
        { modelSelectorEnabled: true, contextEnabled: false },
        "session-1",
        sessionCapabilities,
        onError
      )
    })

    await waitFor(() =>
      expect(result.current.model?.selectEffort).toBeDefined()
    )
    await result.current.model?.selectEffort?.("high")

    await waitFor(() =>
      expect(result.current.model?.effortSelection?.status).toBe("error")
    )
    expect(result.current.model?.effortSelection).toMatchObject({
      status: "error",
      targetId: "high",
    })
    expect(onError).toHaveBeenCalledWith(failure)

    // Retry repeats only the failed request; the authoritative effort stays put.
    expect(result.current.model?.effortId).toBe("medium")
    await result.current.model?.retryEffort?.()
    expect(client.selectEffort).toHaveBeenCalledTimes(2)
    expect(client.selectEffort).toHaveBeenLastCalledWith("session-1", "high")
  })

  it("drops an effort switch that settles after the selected Session changed", async () => {
    let settle: ((value: { effortId: string }) => void) | undefined
    const models = vi.fn(async (threadId: string) => ({
      selectedId: "a",
      effortId: threadId === "session-1" ? "medium" : "low",
      options: [
        { id: "a", label: "A", group: "G", efforts: ["low", "medium", "high"] },
      ],
    }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      selectModel: vi.fn(),
      selectEffort: vi.fn(
        () =>
          new Promise<{ effortId: string }>((resolve) => {
            settle = resolve
          })
      ),
      steerRun: vi.fn(),
    }
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) => {
        const sessionCapabilities = useAosSessionCapabilities(client, threadId)
        return useAosComposerFeatures(
          client,
          { modelSelectorEnabled: true, contextEnabled: false },
          threadId,
          sessionCapabilities
        )
      },
      { initialProps: { threadId: "session-1" } }
    )

    await waitFor(() =>
      expect(result.current.model?.selectEffort).toBeDefined()
    )
    const pending = result.current.model?.selectEffort?.("high")
    rerender({ threadId: "session-2" })
    await waitFor(() => expect(result.current.model?.effortId).toBe("low"))

    settle?.({ effortId: "high" })
    await pending
    expect(result.current.model?.effortId).toBe("low")
    expect(result.current.model?.effortSelection?.status).toBe("idle")
  })

  it("does not expose selectEffort when selected option has no efforts", async () => {
    const models = vi.fn(async () => ({
      selectedId: "a",
      options: [{ id: "a", label: "A", group: "G" }],
    }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      selectModel: vi.fn(),
      selectEffort: vi.fn(),
      steerRun: vi.fn(),
    }
    const { result } = renderHook(() => {
      const sessionCapabilities = useAosSessionCapabilities(client, "session-1")
      return useAosComposerFeatures(
        client,
        { modelSelectorEnabled: true, contextEnabled: false },
        "session-1",
        sessionCapabilities
      )
    })

    await waitFor(() => expect(result.current.model?.selectedId).toBe("a"))
    expect(result.current.model?.selectEffort).toBeUndefined()
  })

  it("exposes provider-neutral steering only when the Session capability is available", async () => {
    const steerRun = vi.fn(async () => ({ status: "steered" as const }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models: vi.fn(),
      context: vi.fn(),
      selectModel: vi.fn(),
      selectEffort: vi.fn(),
      steerRun,
    }
    const { result } = renderHook(() =>
      useAosComposerFeatures(
        client,
        { modelSelectorEnabled: false, contextEnabled: false },
        "session-1",
        capabilities()
      )
    )

    await expect(
      result.current.steer?.({ requestId: "queue-item-1", text: "Correction" })
    ).resolves.toEqual({ status: "steered" })
    expect(steerRun).toHaveBeenCalledWith("session-1", {
      requestId: "queue-item-1",
      text: "Correction",
    })

    const unavailable = {
      ...capabilities(),
      interactions: {
        ...capabilities().interactions,
        steering: { status: "unavailable" as const, reason: "guest" },
      },
    }
    const { result: hidden } = renderHook(() =>
      useAosComposerFeatures(
        client,
        { modelSelectorEnabled: false, contextEnabled: false },
        "session-1",
        unavailable
      )
    )
    expect(hidden.current.steer).toBeUndefined()
  })
})
