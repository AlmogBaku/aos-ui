import { describe, expect, it, vi } from "vitest"

import { createHermesInteractions } from "./use-hermes-runtime-bundle"

describe("createHermesInteractions", () => {
  it("forwards only the exact question request identity to Hermes", async () => {
    const client = {
      answerClarification: vi.fn().mockResolvedValue(undefined),
      rejectClarification: vi.fn().mockResolvedValue(undefined),
      answerApproval: vi.fn().mockResolvedValue(undefined),
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
