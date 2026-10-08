import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  INTERACTION_PROTOCOL,
  type SessionModelUpdateResponse,
} from "@harness-gw/sdk/protocol"
import type {
  HgwContext,
  HgwModelChoices,
  HgwWorkspaceCapabilities,
} from "@harness-gw/sdk"

import {
  useAosComposerFeatures,
  useAosSessionCapabilities,
  useAosSlashCommands,
} from "./aos-composer-features"
import { sessionCapabilities } from "./test-capabilities"

function capabilities(): HgwWorkspaceCapabilities {
  return sessionCapabilities({
    workspace: {
      slashCommands: {
        status: "available",
        scope: "session",
        commands: [{ name: "help" }],
      },
      models: {
        status: "available",
        scope: "session",
        selection: "native-session",
        choices: "provider-reported",
      },
      context: {
        status: "available",
        scope: "session",
        source: "provider-usage-or-estimate",
        breakdown: "provider-categories",
      },
    },
    interactions: {
      steering: {
        status: "available",
        scope: "active-turn",
        semantics: "visible-user-message",
        input: "text",
        fallback: "provider-queue",
      },
      approvals: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "turn",
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
        scope: "turn",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-empty-answer",
        maxQuestions: 32,
        maxChoicesPerQuestion: 64,
        maxAnswerValuesPerQuestion: 64,
        maxStringBytes: 4096,
      },
    },
    content: {
      attachments: {
        status: "available",
        scope: "session",
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
    },
  })
}

const CAPABILITIES = capabilities()

const EFFORTS = [{ id: "low" }, { id: "medium" }, { id: "high" }]

const CHOICES: HgwModelChoices = {
  selectedId: "a",
  effortId: "medium",
  options: [
    { id: "a", label: "A", group: "G", efforts: EFFORTS },
    { id: "b", label: "B", group: "G", efforts: EFFORTS },
  ],
}

type Projection = {
  capabilities?: HgwWorkspaceCapabilities
  models?: Record<string, HgwModelChoices>
  context?: HgwContext
}

type Write = {
  resolve: (answer: SessionModelUpdateResponse) => void
  reject: (reason: Error) => void
}

/**
 * A client whose reads are the Session's projection as the workspace client
 * folds it. `report` changes it the way a Session update does and tells every
 * reader; `writes` holds each model write until the test answers it.
 */
function projectedClient(
  initial: Projection = {
    capabilities: CAPABILITIES,
    models: { "session-1": CHOICES },
  }
) {
  const projection = { ...initial }
  const listeners = new Set<() => void>()
  const writes: Write[] = []
  const client = {
    workspaceCapabilities: () => projection.capabilities,
    models: (sessionId: string) => projection.models?.[sessionId],
    context: () => projection.context,
    subscribeComposer: (_sessionId: string, listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    updateModel: vi.fn<Client["updateModel"]>(
      () => new Promise((resolve, reject) => writes.push({ resolve, reject }))
    ),
    steerRun: vi.fn(async () => ({ status: "steered" as const })),
  }
  const report = (change: Projection) =>
    act(() => {
      Object.assign(projection, change)
      listeners.forEach((listener) => listener())
    })
  return { client, report, writes }
}

type Client = Parameters<typeof useAosComposerFeatures>[0]

function renderComposer(
  client: Client,
  {
    config = { modelSelectorEnabled: true, contextEnabled: false },
    onError,
  }: {
    config?: { modelSelectorEnabled: boolean; contextEnabled: boolean }
    onError?: (error: Error) => void
  } = {}
) {
  return renderHook(
    ({ sessionId }: { sessionId: string }) => {
      const reported = useAosSessionCapabilities(client, sessionId)
      return useAosComposerFeatures(
        client,
        config,
        sessionId,
        reported,
        onError
      )
    },
    { initialProps: { sessionId: "session-1" } }
  )
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

  it("shows the model and the provider's attributed context once the Session reports them", () => {
    const reading = {
      usedTokens: 1_200,
      maxTokens: 8_000,
      source: "provider-usage" as const,
      breakdown: { systemTokens: 100, toolTokens: 200, messageTokens: 900 },
    }
    const { client, report } = projectedClient({})
    const { result } = renderComposer(client, {
      config: { modelSelectorEnabled: true, contextEnabled: true },
    })
    expect(result.current.model).toBeUndefined()
    expect(result.current.context).toBeUndefined()

    report({
      capabilities: CAPABILITIES,
      models: { "session-1": CHOICES },
      context: reading,
    })
    expect(result.current.model?.selectedId).toBe("a")
    // The provider's own attribution reaches the gauge as three segments.
    expect(result.current.context).toEqual({
      usage: { system: 0, tools: 0, messages: 1, total: 8 },
      segments: ["system", "tools", "messages"],
    })

    // A later reading is what the composer shows: the window grows with the
    // conversation, so one read at resume time cannot stay correct.
    report({ context: { ...reading, usedTokens: 4_400 } })
    // The provider's shares are reapportioned over the larger total.
    expect(result.current.context?.usage).toEqual({
      system: 0,
      tools: 1,
      messages: 3,
      total: 8,
    })
  })

  it("shows an unattributed reading as one total rather than hiding the gauge", () => {
    const { client } = projectedClient({
      capabilities: CAPABILITIES,
      context: {
        usedTokens: 2_000,
        maxTokens: 10_000,
        source: "local-estimate",
        estimated: true,
      },
    })
    const { result } = renderComposer(client, {
      config: { modelSelectorEnabled: false, contextEnabled: true },
    })

    expect(result.current.context).toEqual({
      usage: { system: 0, tools: 0, messages: 2, total: 10 },
      segments: [],
    })
  })

  it("reports no context for a runtime that pushes no reading", () => {
    const { client } = projectedClient()
    const { result } = renderComposer(client, {
      config: { modelSelectorEnabled: false, contextEnabled: true },
    })

    expect(result.current.context).toBeUndefined()
  })

  it("shows the picked model at once and settles on the provider's own answer", async () => {
    const { client, report, writes } = projectedClient()
    const { result } = renderComposer(client)

    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.model?.update({ selectedId: "b" })
    })
    expect(result.current.model?.selectedId).toBe("b")
    expect(result.current.model?.selection).toEqual({
      status: "pending",
      target: { selectedId: "b" },
    })
    expect(client.updateModel).toHaveBeenCalledWith("session-1", {
      selectedId: "b",
    })

    // The provider may resolve the pick to a canonical id, and an absent effort
    // means the Session runs on the provider's own default. Its answer lands in
    // the projection before the write resolves.
    report({
      models: {
        "session-1": { options: CHOICES.options, selectedId: "b-2026-09" },
      },
    })
    await act(async () => {
      writes[0]?.resolve({ selectedId: "b-2026-09" })
      await pending
    })

    expect(result.current.model?.selectedId).toBe("b-2026-09")
    expect(result.current.model?.effortId).toBeUndefined()
    expect(result.current.model?.selection?.status).toBe("idle")
  })

  it("keeps the last pick pending when an earlier one answers before it", async () => {
    const { client, writes } = projectedClient()
    const { result } = renderComposer(client)

    let first: Promise<void> | undefined
    act(() => {
      first = result.current.model?.update({ selectedId: "b" })
    })
    act(() => {
      void result.current.model?.update({ effortId: "high" })
    })
    await act(async () => {
      writes[0]?.resolve({ selectedId: "b", effortId: "medium" })
      await first
    })

    // Only the newest pick settles the selection; its target still shows.
    expect(result.current.model?.selection?.status).toBe("pending")
    expect(result.current.model?.effortId).toBe("high")
  })

  it("keeps the last pick on screen when an earlier one fails after it", async () => {
    const { client, writes } = projectedClient()
    const onError = vi.fn()
    const { result } = renderComposer(client, { onError })

    let first: Promise<void> | undefined
    act(() => {
      first = result.current.model?.update({ selectedId: "b" })
    })
    act(() => {
      void result.current.model?.update({ effortId: "high" })
    })
    await act(async () => {
      writes[0]?.reject(new Error("superseded-fail"))
      await first
    })

    // A failure the newer pick already replaced reports nothing; the newer pick
    // is still the one in flight.
    expect(result.current.model?.effortId).toBe("high")
    expect(result.current.model?.selection?.status).toBe("pending")
    expect(onError).not.toHaveBeenCalled()
  })

  it("shows a picked effort over the Session's reported model", () => {
    const { client } = projectedClient()
    const { result } = renderComposer(client)

    act(() => {
      void result.current.model?.update({ effortId: "high" })
    })

    expect(client.updateModel).toHaveBeenCalledWith("session-1", {
      effortId: "high",
    })
    expect(result.current.model?.effortId).toBe("high")
    expect(result.current.model?.selectedId).toBe("a")
  })

  it("restores the reported choice and offers a retry when an update fails", async () => {
    const { client, writes } = projectedClient()
    const onError = vi.fn()
    const { result } = renderComposer(client, { onError })
    const failure = new Error("update-fail")

    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.model?.update({ selectedId: "b" })
    })
    await act(async () => {
      writes[0]?.reject(failure)
      await pending
    })

    expect(result.current.model?.selection).toEqual({
      status: "error",
      target: { selectedId: "b" },
      error: "update-fail",
    })
    expect(onError).toHaveBeenCalledWith(failure)
    // The failed pick reverts to what the Session is still on.
    expect(result.current.model?.selectedId).toBe("a")
    expect(result.current.model?.effortId).toBe("medium")

    act(() => {
      void result.current.model?.retry?.()
    })
    expect(client.updateModel).toHaveBeenCalledTimes(2)
    expect(client.updateModel).toHaveBeenLastCalledWith("session-1", {
      selectedId: "b",
    })
  })

  it("drops an update that settles after the selected Session changed", async () => {
    const { client, writes } = projectedClient({
      capabilities: CAPABILITIES,
      models: {
        "session-1": CHOICES,
        "session-2": { ...CHOICES, selectedId: "b", effortId: "low" },
      },
    })
    const { result, rerender } = renderComposer(client)

    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.model?.update({ effortId: "high" })
    })
    rerender({ sessionId: "session-2" })
    expect(result.current.model?.effortId).toBe("low")

    await act(async () => {
      writes[0]?.resolve({ selectedId: "a", effortId: "high" })
      await pending
    })
    expect(result.current.model?.selectedId).toBe("b")
    expect(result.current.model?.effortId).toBe("low")
    expect(result.current.model?.selection?.status).toBe("idle")
  })

  it("exposes one update for a selected option that reports no efforts", () => {
    const { client } = projectedClient({
      capabilities: CAPABILITIES,
      models: {
        "session-1": {
          selectedId: "a",
          options: [{ id: "a", label: "A", group: "G" }],
        },
      },
    })
    const { result } = renderComposer(client)

    expect(result.current.model?.update).toBeTypeOf("function")
    expect(result.current.model?.effortId).toBeUndefined()
    expect(result.current.model?.options.some((option) => option.efforts)).toBe(
      false
    )
  })

  it("exposes provider-neutral steering only when the Session capability is available", async () => {
    const { client } = projectedClient()
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
    expect(client.steerRun).toHaveBeenCalledWith("session-1", {
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

  it("carries the settled turns' spend and the provider's model feed", () => {
    const follow = {
      current: () => undefined,
      subscribe: () => () => undefined,
    }
    const spend = {
      lastTurn: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      cost: { amount: 0.5, currency: "USD" },
    }
    const { client } = projectedClient({
      capabilities: CAPABILITIES,
      models: { "session-1": CHOICES },
      context: {
        usedTokens: 1_000,
        maxTokens: 8_000,
        source: "provider-usage",
      },
    })
    const { result } = renderComposer(
      { ...client, turnUsage: () => spend, modelFeed: () => follow },
      { config: { modelSelectorEnabled: true, contextEnabled: true } }
    )

    expect(result.current.model?.follow).toBe(follow)
    expect(result.current.context).toMatchObject(spend)
  })
})
