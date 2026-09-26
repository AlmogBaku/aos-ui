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
    getPending: (sessionId) => pending.get(sessionId),
    subscribe: (sessionId, listener) => {
      const set = listeners.get(sessionId) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(sessionId, set)
      return () => set.delete(listener)
    },
  }
  function set(sessionId: string, request: RuntimeQuestionRequest | undefined) {
    if (request) pending.set(sessionId, request)
    else pending.delete(sessionId)
    act(() => listeners.get(sessionId)?.forEach((listener) => listener()))
  }
  return { adapter, set, listeners }
}

function Probe({
  interactions,
  sessionId,
}: {
  interactions?: RuntimeInteractionAdapter
  sessionId?: string
}) {
  return (
    <output>
      {useHasPendingInteraction(interactions, sessionId) ? "pending" : "idle"}
    </output>
  )
}

afterEach(cleanup)

describe("useHasPendingInteraction", () => {
  it("tracks the selected Session's pending request", () => {
    const { adapter, set } = fakeInteractions()
    render(<Probe interactions={adapter} sessionId="session-1" />)
    expect(screen.getByRole("status")).toHaveTextContent("idle")

    set("session-1", questionRequest("session-1"))
    expect(screen.getByRole("status")).toHaveTextContent("pending")

    set("session-1", undefined)
    expect(screen.getByRole("status")).toHaveTextContent("idle")
  })

  it("ignores another Session's pending request", () => {
    const { adapter, set } = fakeInteractions()
    render(<Probe interactions={adapter} sessionId="session-1" />)

    set("session-2", questionRequest("session-2"))

    expect(screen.getByRole("status")).toHaveTextContent("idle")
  })

  it("stays idle without an interactions adapter or a Session", () => {
    const { adapter, listeners } = fakeInteractions()
    const view = render(<Probe sessionId="session-1" />)
    expect(screen.getByRole("status")).toHaveTextContent("idle")

    view.rerender(<Probe interactions={adapter} />)
    expect(screen.getByRole("status")).toHaveTextContent("idle")
    expect(listeners.size).toBe(0)
  })

  it("unsubscribes the Session it leaves", () => {
    const { adapter, listeners } = fakeInteractions()
    const view = render(<Probe interactions={adapter} sessionId="session-1" />)
    expect(listeners.get("session-1")?.size).toBe(1)

    view.rerender(<Probe interactions={adapter} sessionId="session-2" />)

    expect(listeners.get("session-1")?.size).toBe(0)
    expect(listeners.get("session-2")?.size).toBe(1)
  })
})
