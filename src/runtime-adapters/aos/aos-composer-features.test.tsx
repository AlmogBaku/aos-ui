import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { INTERACTION_PROTOCOL } from "@aos/protocol"

import type { AosWorkspaceCapabilities } from "./aos-client"
import {
  useAosComposerFeatures,
  useAosSessionCapabilities,
  useAosSlashCommands,
} from "./aos-composer-features"

function capabilities(): AosWorkspaceCapabilities {
  return {
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
        protocol: INTERACTION_PROTOCOL,
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
        protocol: INTERACTION_PROTOCOL,
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
      mcpApps: { status: "unavailable", reason: "not-supported" },
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
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(),
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

  it("projects normalized selected model and the provider's attributed context for only the selected Session", async () => {
    const models = vi.fn(async () => ({
      selectedId: "small",
      options: [{ id: "small", label: "Small", group: "Native" }],
    }))
    let reading = {
      usedTokens: 1_200,
      maxTokens: 8_000,
      source: "provider-usage" as const,
      breakdown: { systemTokens: 100, toolTokens: 200, messageTokens: 900 },
    }
    let announce: (() => void) | undefined
    const context = vi.fn(() => reading)
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context,
      subscribeContext: vi.fn((_threadId: string, listener: () => void) => {
        announce = listener
        return () => undefined
      }),
      updateModel: vi.fn(),
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
    // The provider's own attribution reaches the gauge as three segments.
    expect(result.current.context).toEqual({
      usage: { system: 0, tools: 0, messages: 1, total: 8 },
      segments: ["system", "tools", "messages"],
    })
    expect(models).toHaveBeenCalledWith("session-1")
    expect(client.subscribeContext).toHaveBeenCalledWith(
      "session-1",
      expect.any(Function)
    )

    // A later reading is what the composer shows: the window grows with the
    // conversation, so one read at attach time cannot stay correct.
    reading = { ...reading, usedTokens: 4_400 }
    act(() => announce?.())

    await waitFor(() =>
      // The provider's shares are reapportioned over the larger total.
      expect(result.current.context?.usage).toEqual({
        system: 0,
        tools: 1,
        messages: 3,
        total: 8,
      })
    )
  })

  it("shows an unattributed reading as one total rather than hiding the gauge", async () => {
    const unattributed = {
      usedTokens: 2_000,
      maxTokens: 10_000,
      source: "local-estimate" as const,
      estimated: true as const,
    }
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models: vi.fn(),
      context: vi.fn(() => unattributed),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(),
      steerRun: vi.fn(),
    }
    const { result } = renderHook(() => {
      const sessionCapabilities = useAosSessionCapabilities(client, "session-1")
      return useAosComposerFeatures(
        client,
        { modelSelectorEnabled: false, contextEnabled: true },
        "session-1",
        sessionCapabilities
      )
    })

    await waitFor(() => expect(result.current.context).toBeDefined())
    expect(result.current.context).toEqual({
      usage: { system: 0, tools: 0, messages: 2, total: 10 },
      segments: [],
    })
  })

  it("reports no context for a runtime that pushes no reading", async () => {
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models: vi.fn(),
      context: vi.fn(() => undefined),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(),
      steerRun: vi.fn(),
    }
    const { result } = renderHook(() => {
      const sessionCapabilities = useAosSessionCapabilities(client, "session-1")
      return useAosComposerFeatures(
        client,
        { modelSelectorEnabled: false, contextEnabled: true },
        "session-1",
        sessionCapabilities
      )
    })

    await waitFor(() =>
      expect(client.workspaceCapabilities).toHaveBeenCalledOnce()
    )
    expect(result.current.context).toBeUndefined()
  })

  it("shows the picked model at once and settles on the provider's own answer", async () => {
    const models = vi.fn(async () => ({
      selectedId: "small",
      effortId: "medium",
      options: [
        { id: "small", label: "Small", group: "Native" },
        {
          id: "large",
          label: "Large",
          group: "Native",
          efforts: ["low", "medium", "high"],
        },
      ],
    }))
    let settle:
      ((value: { selectedId: string; effortId?: string }) => void) | undefined
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(
        () =>
          new Promise<{ selectedId: string; effortId?: string }>((resolve) => {
            settle = resolve
          })
      ),
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

    await waitFor(() => expect(result.current.model?.selectedId).toBe("small"))
    const pending = result.current.model?.update({ selectedId: "large" })

    await waitFor(() => expect(result.current.model?.selectedId).toBe("large"))
    expect(result.current.model?.selection).toEqual({
      status: "pending",
      target: { selectedId: "large" },
    })
    expect(client.updateModel).toHaveBeenCalledWith("session-1", {
      selectedId: "large",
    })

    // The provider may resolve the pick to a canonical id, and an absent effort
    // means the Session runs on the provider's own default.
    settle?.({ selectedId: "large-2026-09" })
    await pending

    await waitFor(() =>
      expect(result.current.model?.selectedId).toBe("large-2026-09")
    )
    expect(result.current.model?.effortId).toBeUndefined()
    expect(result.current.model?.selection?.status).toBe("idle")
    // The write already answered authoritatively; a re-read would race it.
    expect(models).toHaveBeenCalledTimes(1)
  })

  it("lets the last pick win when an earlier one answers after it", async () => {
    const models = vi.fn(async () => ({
      selectedId: "small",
      options: [
        { id: "small", label: "Small", group: "Native" },
        { id: "medium", label: "Medium", group: "Native" },
        { id: "large", label: "Large", group: "Native" },
      ],
    }))
    const settlers: ((value: { selectedId: string }) => void)[] = []
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(
        () =>
          new Promise<{ selectedId: string }>((resolve) => {
            settlers.push(resolve)
          })
      ),
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

    await waitFor(() => expect(result.current.model?.selectedId).toBe("small"))
    const first = result.current.model?.update({ selectedId: "medium" })
    await waitFor(() => expect(result.current.model?.selectedId).toBe("medium"))
    const second = result.current.model?.update({ selectedId: "large" })
    await waitFor(() => expect(result.current.model?.selectedId).toBe("large"))

    // The second pick answers first, then the first pick's answer arrives late.
    settlers[1]?.({ selectedId: "large-2026-09" })
    await second
    settlers[0]?.({ selectedId: "medium-2026-09" })
    await first

    await waitFor(() =>
      expect(result.current.model?.selectedId).toBe("large-2026-09")
    )
    expect(result.current.model?.selection?.status).toBe("idle")
  })

  it("keeps the last pick on screen when an earlier one fails after it", async () => {
    const models = vi.fn(async () => ({
      selectedId: "small",
      options: [
        { id: "small", label: "Small", group: "Native" },
        { id: "medium", label: "Medium", group: "Native" },
        { id: "large", label: "Large", group: "Native" },
      ],
    }))
    const rejecters: ((reason: Error) => void)[] = []
    const settlers: ((value: { selectedId: string }) => void)[] = []
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(
        () =>
          new Promise<{ selectedId: string }>((resolve, reject) => {
            settlers.push(resolve)
            rejecters.push(reject)
          })
      ),
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

    await waitFor(() => expect(result.current.model?.selectedId).toBe("small"))
    const first = result.current.model?.update({ selectedId: "medium" })
    await waitFor(() => expect(result.current.model?.selectedId).toBe("medium"))
    const second = result.current.model?.update({ selectedId: "large" })
    await waitFor(() => expect(result.current.model?.selectedId).toBe("large"))

    rejecters[0]?.(new Error("superseded-fail"))
    await first

    // A failure the newer pick already replaced reverts nothing and reports
    // nothing; the newer pick is still the one in flight.
    expect(result.current.model?.selectedId).toBe("large")
    expect(result.current.model?.selection?.status).toBe("pending")
    expect(onError).not.toHaveBeenCalled()

    settlers[1]?.({ selectedId: "large" })
    await second
    await waitFor(() =>
      expect(result.current.model?.selection?.status).toBe("idle")
    )
    expect(result.current.model?.selectedId).toBe("large")
  })
  it("settles the reasoning effort half from the same authoritative response", async () => {
    const models = vi.fn(async () => ({
      selectedId: "a",
      effortId: "medium",
      options: [
        { id: "a", label: "A", group: "G", efforts: ["low", "medium", "high"] },
      ],
    }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(async () => ({ selectedId: "a", effortId: "high" })),
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

    await waitFor(() => expect(result.current.model?.effortId).toBe("medium"))
    await result.current.model?.update({ effortId: "high" })

    expect(client.updateModel).toHaveBeenCalledWith("session-1", {
      effortId: "high",
    })
    await waitFor(() => expect(result.current.model?.effortId).toBe("high"))
    expect(result.current.model?.selectedId).toBe("a")
    expect(models).toHaveBeenCalledTimes(1)
  })

  it("restores the previous choice and offers a retry when an update fails", async () => {
    const models = vi.fn(async () => ({
      selectedId: "a",
      effortId: "medium",
      options: [
        { id: "a", label: "A", group: "G", efforts: ["low", "medium", "high"] },
        { id: "b", label: "B", group: "G" },
      ],
    }))
    const failure = new Error("update-fail")
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(async () => {
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

    await waitFor(() => expect(result.current.model?.selectedId).toBe("a"))
    await result.current.model?.update({ selectedId: "b" })

    await waitFor(() =>
      expect(result.current.model?.selection?.status).toBe("error")
    )
    expect(result.current.model?.selection).toEqual({
      status: "error",
      target: { selectedId: "b" },
      error: "update-fail",
    })
    expect(onError).toHaveBeenCalledWith(failure)
    // The failed pick reverts to what the Session is still on.
    expect(result.current.model?.selectedId).toBe("a")
    expect(result.current.model?.effortId).toBe("medium")

    await result.current.model?.retry?.()
    expect(client.updateModel).toHaveBeenCalledTimes(2)
    expect(client.updateModel).toHaveBeenLastCalledWith("session-1", {
      selectedId: "b",
    })
  })

  it("drops an update that settles after the selected Session changed", async () => {
    let settle: ((value: { selectedId: string }) => void) | undefined
    const models = vi.fn(async (threadId: string) => ({
      selectedId: threadId === "session-1" ? "a" : "b",
      effortId: threadId === "session-1" ? "medium" : "low",
      options: [
        { id: "a", label: "A", group: "G", efforts: ["low", "medium", "high"] },
        { id: "b", label: "B", group: "G", efforts: ["low", "medium", "high"] },
      ],
    }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(
        () =>
          new Promise<{ selectedId: string }>((resolve) => {
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

    await waitFor(() => expect(result.current.model?.selectedId).toBe("a"))
    const pending = result.current.model?.update({ effortId: "high" })
    rerender({ threadId: "session-2" })
    await waitFor(() => expect(result.current.model?.effortId).toBe("low"))

    settle?.({ selectedId: "a" })
    await pending
    expect(result.current.model?.selectedId).toBe("b")
    expect(result.current.model?.effortId).toBe("low")
    expect(result.current.model?.selection?.status).toBe("idle")
  })

  it("exposes one update for a selected option that reports no efforts", async () => {
    const models = vi.fn(async () => ({
      selectedId: "a",
      options: [{ id: "a", label: "A", group: "G" }],
    }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models,
      context: vi.fn(),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(),
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
    expect(result.current.model?.update).toBeTypeOf("function")
    expect(result.current.model?.effortId).toBeUndefined()
    expect(result.current.model?.options.some((option) => option.efforts)).toBe(
      false
    )
  })

  it("exposes provider-neutral steering only when the Session capability is available", async () => {
    const steerRun = vi.fn(async () => ({ status: "steered" as const }))
    const client = {
      workspaceCapabilities: vi.fn(async () => capabilities()),
      models: vi.fn(),
      context: vi.fn(),
      subscribeContext: () => () => undefined,
      updateModel: vi.fn(),
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
