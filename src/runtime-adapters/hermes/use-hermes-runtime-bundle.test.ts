import { describe, expect, it, vi } from "vitest"

import { createHermesInteractions } from "./use-hermes-runtime-bundle"

describe("createHermesInteractions", () => {
  it("discovers stable, localized pending snapshots and notifies only the requested Session", () => {
    const listeners = new Set<() => void>()
    let clarification = {
      requestId: "clarify-one",
      questions: [
        {
          id: "region",
          question: "Region?",
          choices: ["IL", "US"],
          multiple: false,
        },
      ],
    }
    const client = {
      answerClarification: vi.fn(),
      rejectClarification: vi.fn(),
      session: (threadId: string) =>
        threadId === "thread-one" ? { clarification } : undefined,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    const interactions = createHermesInteractions(client, "he")
    const snapshot = interactions.getPending("thread-one")
    expect(snapshot).toEqual({
      kind: "question",
      requestId: "clarify-one",
      sessionId: "thread-one",
      questions: [
        {
          id: "region",
          header: "שאלה 1",
          prompt: "Region?",
          options: [{ label: "IL" }, { label: "US" }],
          multiple: false,
          custom: true,
        },
      ],
    })
    expect(interactions.getPending("thread-one")).toBe(snapshot)
    expect(interactions.getPending("thread-two")).toBeUndefined()
    const listener = vi.fn()
    const unsubscribe = interactions.subscribe("thread-one", listener)
    for (const notify of listeners) notify()
    expect(listener).not.toHaveBeenCalled()
    clarification = { ...clarification, requestId: "clarify-two" }
    for (const notify of listeners) notify()
    expect(listener).toHaveBeenCalledOnce()
    expect(interactions.getPending("thread-one")?.requestId).toBe("clarify-two")
    unsubscribe()
    expect(listeners.size).toBe(0)
  })

  it("forwards only the exact question request identity to Hermes", async () => {
    const client = {
      answerClarification: vi.fn().mockResolvedValue(undefined),
      rejectClarification: vi.fn().mockResolvedValue(undefined),
      answerApproval: vi.fn().mockResolvedValue(undefined),
      session: () => undefined,
      subscribe: () => () => undefined,
    }
    const interactions = createHermesInteractions(client)
    const request = {
      kind: "question" as const,
      requestId: "clarify-one",
      sessionId: "thread-one",
      questions: [],
    }

    await interactions.respond(request, {
      kind: "question",
      answers: [["one"], ["two"]],
    })
    await interactions.reject(request)

    expect(client.answerClarification).toHaveBeenCalledWith(
      "thread-one",
      "clarify-one",
      [["one"], ["two"]]
    )
    expect(client.rejectClarification).toHaveBeenCalledWith(
      "thread-one",
      "clarify-one"
    )
  })
})
