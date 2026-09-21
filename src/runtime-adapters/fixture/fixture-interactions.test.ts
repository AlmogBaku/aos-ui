import { describe, expect, it, vi } from "vitest"

import type { RuntimeQuestionRequest } from "@/runtime-adapters/contracts"
import { createFixtureInteractions } from "./fixture-interactions"

const questionRequest: RuntimeQuestionRequest = {
  kind: "question",
  requestId: "req-1",
  sessionId: "thread-aster-market",
  questions: [
    {
      header: "Which audience should the brief prioritize?",
      prompt: "",
      options: [
        { label: "Executive team" },
        { label: "Product team" },
        { label: "Investors" },
      ],
      custom: true,
    },
  ],
}

describe("createFixtureInteractions", () => {
  it("has no pending request before registration", () => {
    const adapter = createFixtureInteractions()
    expect(adapter.getPending("thread-aster-market")).toBeUndefined()
  })

  it("returns a pending request after registration and notifies subscribers", () => {
    const adapter = createFixtureInteractions()
    const listener = vi.fn()
    adapter.subscribe("thread-aster-market", listener)

    adapter.register(questionRequest)

    expect(adapter.getPending("thread-aster-market")).toBe(questionRequest)
    expect(listener).toHaveBeenCalledOnce()
  })

  it("clears the pending request and delivers answers on respond", async () => {
    const appended: string[][][] = []
    const adapter = createFixtureInteractions((_, answers) => appended.push(answers))
    const listener = vi.fn()
    adapter.subscribe("thread-aster-market", listener)
    adapter.register(questionRequest)

    await adapter.respond(questionRequest, {
      kind: "question",
      answers: [["Executive team"]],
    })

    expect(adapter.getPending("thread-aster-market")).toBeUndefined()
    expect(appended).toEqual([[["Executive team"]]])
    // one notification on register, one on respond
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("clears the pending request on reject without calling onAnswer", async () => {
    const onAnswer = vi.fn()
    const adapter = createFixtureInteractions(onAnswer)
    adapter.register(questionRequest)

    await adapter.reject(questionRequest)

    expect(adapter.getPending("thread-aster-market")).toBeUndefined()
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("ignores respond for a stale or absent request", async () => {
    const onAnswer = vi.fn()
    const adapter = createFixtureInteractions(onAnswer)
    // no register call

    await adapter.respond(questionRequest, { kind: "question", answers: [] })

    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("unsubscribes cleanly", () => {
    const adapter = createFixtureInteractions()
    const listener = vi.fn()
    const unsubscribe = adapter.subscribe("thread-aster-market", listener)

    unsubscribe()
    adapter.register(questionRequest)

    expect(listener).not.toHaveBeenCalled()
  })
})
