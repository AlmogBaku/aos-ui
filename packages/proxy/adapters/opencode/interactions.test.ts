import { describe, expect, it, vi } from "vitest"

import { OpenCodeMutationUncertainError } from "./client"
import { OpenCodeInteractions } from "./interactions"

const scope = {
  agentId: "research",
  sessionId: "native-session-1",
  threadId: "session-public-1",
  runId: "run-1",
}

describe("OpenCodeInteractions", () => {
  it("validates a complete native question batch and maps its ordered response once", async () => {
    const reply = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: vi.fn(async () => undefined) },
    })

    const interrupt = interactions.acceptQuestion(scope, {
      id: "native-question-id",
      sessionID: "native-session-1",
      questions: [
        {
          header: "Region",
          question: "Where should this run?",
          options: [
            { label: "Europe", description: "EU" },
            { label: "US", description: "United States" },
          ],
        },
        {
          header: "Checks",
          question: "Which checks?",
          options: [{ label: "Lint", description: "Static checks" }],
          multiple: true,
        },
      ],
    })

    expect(interrupt).toMatchObject({
      type: "interrupt",
      interrupts: [
        {
          id: "native-question-id",
          reason: "question",
          message: "2 questions require answers",
        },
      ],
    })
    await expect(
      interactions.respond(scope, [
        {
          interruptId: "native-question-id",
          status: "resolved",
          payload: [["option-1"], ["option-1"]],
        },
      ])
    ).resolves.toEqual({ status: "resolved" })
    expect(reply).toHaveBeenCalledWith(
      "native-session-1",
      "native-question-id",
      {
        answers: [["Europe"], ["Lint"]],
      }
    )
  })

  it("rejects incomplete or choice-substituted responses before native dispatch", async () => {
    const reply = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: vi.fn(async () => undefined) },
    })
    interactions.acceptQuestion(scope, {
      id: "native-question-id",
      sessionID: "native-session-1",
      questions: [
        {
          header: "Region",
          question: "Where?",
          options: [{ label: "Europe", description: "EU" }],
        },
        {
          header: "Check",
          question: "Which?",
          options: [{ label: "Lint", description: "Static" }],
        },
      ],
    })

    await expect(
      interactions.respond(scope, [
        {
          interruptId: "native-question-id",
          status: "resolved",
          payload: [["option-1"]],
        },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    await expect(
      interactions.respond(scope, [
        {
          interruptId: "native-question-id",
          status: "resolved",
          payload: [["Outside"], ["option-1"]],
        },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    expect(reply).not.toHaveBeenCalled()
  })

  it("maps complete session-scoped resume batches from a new segment back to exact native labels", async () => {
    const reply = vi.fn(async () => undefined)
    const permission = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: permission },
    })
    const question = interactions.acceptQuestion(scope, {
      id: "question-1",
      sessionID: "native-session-1",
      questions: [
        {
          header: "Path",
          question: "Choose",
          options: [{ label: "/private/a", description: "A" }],
        },
      ],
    })
    interactions.acceptPermission(scope, {
      id: "permission-1",
      sessionID: "native-session-1",
      action: "write",
      resources: [],
    })
    const publicChoice = (
      question.interrupts[0]!.responseSchema!.items as Array<{
        items: { enum: string[] }
      }>
    )[0]!.items.enum[0]!

    await expect(
      interactions.respond({ ...scope, runId: "resume-segment" }, [
        {
          interruptId: "question-1",
          status: "resolved",
          payload: [[publicChoice]],
        },
        { interruptId: "permission-1", status: "resolved", payload: "once" },
      ])
    ).resolves.toEqual({ status: "resolved" })
    expect(reply).toHaveBeenCalledWith("native-session-1", "question-1", {
      answers: [["/private/a"]],
    })
    expect(permission).toHaveBeenCalledWith(
      "native-session-1",
      "permission-1",
      "once"
    )
  })

  it("removes externally resolved interactions during authoritative reconciliation without dispatch", async () => {
    const reply = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: vi.fn(async () => undefined) },
    })
    interactions.acceptQuestion(scope, {
      id: "question-1",
      sessionID: "native-session-1",
      questions: [
        {
          header: "A",
          question: "A?",
          options: [{ label: "Yes", description: "Y" }],
        },
      ],
    })
    interactions.reconcile(scope, { questions: [], permissions: [] })
    await expect(
      interactions.respond({ ...scope, runId: "resume-segment" }, [
        {
          interruptId: "question-1",
          status: "resolved",
          payload: [["option-1"]],
        },
      ])
    ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
    expect(reply).not.toHaveBeenCalled()
  })

  it("does not redispatch an uncertain response when reconciliation still lists the interaction", async () => {
    const reply = vi.fn(async () => {
      throw new OpenCodeMutationUncertainError()
    })
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: vi.fn(async () => undefined) },
    })
    const question = {
      id: "question-1",
      sessionID: "native-session-1",
      questions: [
        {
          header: "A",
          question: "A?",
          options: [{ label: "Yes", description: "Y" }],
        },
      ],
    }
    const response = [
      {
        interruptId: "question-1",
        status: "resolved",
        payload: [["option-1"]],
      },
    ]
    interactions.acceptQuestion(scope, question)

    await expect(interactions.respond(scope, response)).rejects.toMatchObject({
      code: "AOS_MUTATION_UNCERTAIN",
    })
    interactions.reconcile(scope, { questions: [question], permissions: [] })

    await expect(interactions.respond(scope, response)).resolves.toEqual({
      status: "in-progress",
    })
    expect(reply).toHaveBeenCalledTimes(1)
  })
})
