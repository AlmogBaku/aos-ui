import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import { useHasPendingInteraction } from "./use-has-pending-interaction"

function questionRequest(sessionId: string): RuntimeQuestionRequest {
  return {
    kind: "question",
    requestId: `${sessionId}-request`,
    sessionId,
    questions: [
      {
        header: "Confirm",
        prompt: "Continue?",
        options: [{ label: "Yes" }],
        multiple: false,
        custom: false,
      },
    ],
  }
}

function fakeInteractions() {
  const pending = new Map<string, RuntimeQuestionRequest>()
  const listeners = new Map<string, Set<() => void>>()
  const adapter: RuntimeInteractionAdapter = {
    respond: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    getPending: (threadId) => pending.get(threadId),
    subscribe: (threadId, listener) => {
      const set = listeners.get(threadId) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(threadId, set)
      return () => set.delete(listener)
    },
  }
  function set(threadId: string, request: RuntimeQuestionRequest | undefined) {
    if (request) pending.set(threadId, request)
    else pending.delete(threadId)
    act(() => listeners.get(threadId)?.forEach((listener) => listener()))
  }
  return { adapter, set, listeners }
}

function Probe({
  interactions,
  threadId,
}: {
  interactions?: RuntimeInteractionAdapter
  threadId?: string
}) {
  return (
    <output>
      {useHasPendingInteraction(interactions, threadId) ? "pending" : "idle"}
    </output>
  )
}

afterEach(cleanup)

describe("useHasPendingInteraction", () => {
  it("tracks the selected Session's pending request", () => {
    const { adapter, set } = fakeInteractions()
    render(<Probe interactions={adapter} threadId="session-1" />)
    expect(screen.getByRole("status")).toHaveTextContent("idle")

    set("session-1", questionRequest("session-1"))
    expect(screen.getByRole("status")).toHaveTextContent("pending")

    set("session-1", undefined)
    expect(screen.getByRole("status")).toHaveTextContent("idle")
  })

  it("ignores another Session's pending request", () => {
    const { adapter, set } = fakeInteractions()
    render(<Probe interactions={adapter} threadId="session-1" />)

    set("session-2", questionRequest("session-2"))

    expect(screen.getByRole("status")).toHaveTextContent("idle")
  })

  it("stays idle without an interactions adapter or a Session", () => {
    const { adapter, listeners } = fakeInteractions()
    const view = render(<Probe threadId="session-1" />)
    expect(screen.getByRole("status")).toHaveTextContent("idle")

    view.rerender(<Probe interactions={adapter} />)
    expect(screen.getByRole("status")).toHaveTextContent("idle")
    expect(listeners.size).toBe(0)
  })

  it("unsubscribes the Session it leaves", () => {
    const { adapter, listeners } = fakeInteractions()
    const view = render(<Probe interactions={adapter} threadId="session-1" />)
    expect(listeners.get("session-1")?.size).toBe(1)

    view.rerender(<Probe interactions={adapter} threadId="session-2" />)

    expect(listeners.get("session-1")?.size).toBe(0)
    expect(listeners.get("session-2")?.size).toBe(1)
  })
})
