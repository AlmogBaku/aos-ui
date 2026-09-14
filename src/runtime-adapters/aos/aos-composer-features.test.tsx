import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { AosWorkspaceCapabilities } from "./aos-client"
import {
  useAosComposerFeatures,
  useAosSessionCapabilities,
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
  it("reads the selected Session capability projection even when presentation policy hides composer features", async () => {
    const workspaceCapabilities = vi.fn(async () => capabilities())
    const models = vi.fn()
    const context = vi.fn()
    const client = {
      workspaceCapabilities,
      models,
      context,
      selectModel: vi.fn(),
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
})
