import { describe, expect, it, vi } from "vitest"

import { createAosInteractions } from "./aos-interactions"

describe("AOS normalized interactions", () => {
  it("projects a normalized question interrupt and resumes its owned Session", async () => {
    const pendingInteraction = vi.fn(async () => ({
      runId: "run-1",
      running: true,
      status: "waiting-for-input" as const,
      outcome: {
        type: "interrupt" as const,
        interrupts: [
          {
            id: "question-1",
            reason: "question" as const,
            message: "Choose",
            responseSchema: {
              type: "object",
              properties: {
                answers: {
                  type: "array",
                  prefixItems: [
                    {
                      type: "array",
                      title: "Choose",
                      items: { type: "string", enum: ["Yes", "No"] },
                      minItems: 0,
                      maxItems: 1,
                    },
                  ],
                },
              },
            },
            metadata: { "aos.kind": "questions" },
          },
        ],
      },
    }))
    const respondToInteraction = vi.fn(async () => undefined)
    const interactions = createAosInteractions({
      pendingInteraction,
      respondToInteraction,
    })
    const listener = vi.fn()
    const stop = interactions.subscribe("session-1", listener)
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())

    expect(interactions.getPending("session-1")).toMatchObject({
      requestId: "question-1",
      questions: [
        { prompt: "Choose", options: [{ label: "Yes" }, { label: "No" }] },
      ],
    })
    await interactions.respond(interactions.getPending("session-1")!, {
      kind: "question",
      answers: [["Yes"]],
    })
    expect(respondToInteraction).toHaveBeenCalledWith(
      "session-1",
      "run-1",
      "question-1",
      { kind: "question", answers: [["Yes"]] }
    )
    stop()
  })
})
