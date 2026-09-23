import { describe, expect, it, vi } from "vitest"

import { PendingRequestKind } from "../../core/events"

import { OpenCodeMutationUncertainError } from "./client"
import { OpenCodeInteractions } from "./interactions"

const scope = {
  agentId: "research",
  sessionId: "native-session-1",
  threadId: "session-public-1",
  turnId: "run-1",
}

describe("OpenCodeInteractions", () => {
  it("discovers and binds one complete authoritative exact-Session batch", async () => {
    const questions = vi.fn(async () => ({
      data: [
        {
          id: "question-1",
          sessionID: "native-session-1",
          questions: [
            {
              header: "Region",
              question: "Where?",
              options: [{ label: "Europe", description: "EU" }],
            },
          ],
        },
      ],
    }))
    const permissions = vi.fn(async () => ({
      data: [
        {
          id: "permission-1",
          sessionID: "native-session-1",
          action: "write",
          resources: [],
        },
      ],
    }))
    const interactions = new OpenCodeInteractions({
      questions: {
        list: questions,
        reply: vi.fn(async () => undefined),
        reject: vi.fn(async () => undefined),
      },
      permissions: { list: permissions, reply: vi.fn(async () => undefined) },
    })

    await expect(interactions.discover(scope)).resolves.toEqual([
      expect.objectContaining({
        requestId: "question-1",
        kind: PendingRequestKind.Elicitation,
      }),
      expect.objectContaining({
        requestId: "permission-1",
        kind: PendingRequestKind.Permission,
      }),
    ])
    expect(questions).toHaveBeenCalledWith("native-session-1")
    expect(permissions).toHaveBeenCalledWith("native-session-1")
  })

  it("separates a bound reply validation from its one native dispatch", async () => {
    const reply = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: {
        list: async () => ({ data: [] }),
        reply,
        reject: vi.fn(async () => undefined),
      },
      permissions: {
        list: async () => ({ data: [] }),
        reply: vi.fn(async () => undefined),
      },
    })
    interactions.acceptQuestion(scope, {
      id: "question-1",
      sessionID: "native-session-1",
      questions: [
        {
          header: "Region",
          question: "Where?",
          options: [{ label: "Europe", description: "EU" }],
        },
      ],
    })
    const replies = [
      {
        requestId: "question-1",
        status: "resolved" as const,
        payload: { answers: [["Europe"]] },
      },
    ]

    await interactions.validate(scope, replies)
    expect(reply).not.toHaveBeenCalled()
    await interactions.dispatch(scope, replies)
    expect(reply).toHaveBeenCalledOnce()
    await expect(interactions.dispatch(scope, replies)).rejects.toMatchObject({
      code: "AOS_INTERACTION_NOT_FOUND",
    })
  })

  it("validates a complete native question batch and maps its ordered response once", async () => {
    const reply = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: vi.fn(async () => undefined) },
    })

    const requests = interactions.acceptQuestion(scope, {
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

    expect(requests).toMatchObject([
      {
        requestId: "native-question-id",
        kind: PendingRequestKind.Elicitation,
        message: "2 questions require answers",
        questions: [
          {
            label: "Region",
            text: "Where should this run?",
            choices: ["Europe", "US"],
            multiple: false,
            custom: true,
          },
          {
            label: "Checks",
            text: "Which checks?",
            choices: ["Lint"],
            multiple: true,
            custom: true,
          },
        ],
      },
    ])
    await expect(
      interactions.respond(scope, [
        {
          requestId: "native-question-id",
          status: "resolved",
          payload: { answers: [["Europe"], ["Lint"]] },
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

  it("keeps the choices of a multi-choice question and answers every one", async () => {
    const reply = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: vi.fn(async () => undefined) },
    })

    const [request] = interactions.acceptQuestion(scope, {
      id: "question-1",
      sessionID: "native-session-1",
      questions: [
        {
          header: "Checks",
          question: "Which checks?",
          options: [
            { label: "Lint", description: "Static checks" },
            { label: "Unit", description: "Unit tests" },
            { label: "E2E", description: "Browser tests" },
          ],
          multiple: true,
          custom: false,
        },
      ],
    })

    expect(request?.questions).toEqual([
      {
        label: "Checks",
        text: "Which checks?",
        choices: ["Lint", "Unit", "E2E"],
        multiple: true,
        custom: false,
      },
    ])
    await interactions.respond(scope, [
      {
        requestId: "question-1",
        status: "resolved",
        payload: { answers: [["Lint", "E2E"]] },
      },
    ])
    expect(reply).toHaveBeenCalledWith("native-session-1", "question-1", {
      answers: [["Lint", "E2E"]],
    })
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
          custom: false,
        },
        {
          header: "Check",
          question: "Which?",
          options: [{ label: "Lint", description: "Static" }],
          custom: false,
        },
      ],
    })

    await expect(
      interactions.respond(scope, [
        {
          requestId: "native-question-id",
          status: "resolved",
          payload: { answers: [["Europe"]] },
        },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    await expect(
      interactions.respond(scope, [
        {
          requestId: "native-question-id",
          status: "resolved",
          payload: { answers: [["Outside"], ["Lint"]] },
        },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    expect(reply).not.toHaveBeenCalled()
  })

  it("maps complete session-scoped reply batches from a new segment back to exact native labels", async () => {
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
    const choice = question[0]!.questions![0]!.choices[0]!

    await expect(
      interactions.respond({ ...scope, turnId: "reply-segment" }, [
        {
          requestId: "question-1",
          status: "resolved",
          payload: { answers: [[choice]] },
        },
        { requestId: "permission-1", status: "resolved", payload: "once" },
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

  const permission = {
    id: "permission-1",
    sessionID: "native-session-1",
    action: "edit",
    resources: ["src/a.ts", "src/b.ts"],
    source: { type: "tool", messageID: "message-1", callID: "call-1" },
  }
  const linkedPermission = {
    requestId: "permission-1",
    kind: PendingRequestKind.Permission,
    toolCallId: "call-1",
    message: "src/a.ts\nsrc/b.ts",
    responseSchema: {
      type: "string",
      title: "edit",
      enum: ["once", "always", "deny"],
    },
  }
  const newInteractions = () =>
    new OpenCodeInteractions({
      questions: {
        reply: vi.fn(async () => undefined),
        reject: vi.fn(async () => undefined),
      },
      permissions: { reply: vi.fn(async () => undefined) },
    })

  it("names the tool call a permission guards, its action, and its resources", () => {
    expect(newInteractions().acceptPermission(scope, permission)).toEqual([
      linkedPermission,
    ])
  })

  it("leaves a permission without a tool source unlinked", () => {
    const unsourced = { ...permission, source: undefined }
    const unlinked = { ...linkedPermission }
    delete (unlinked as { toolCallId?: string }).toolCallId
    expect(newInteractions().acceptPermission(scope, unsourced)).toEqual([
      unlinked,
    ])
    expect(
      newInteractions().acceptPermission(scope, {
        ...permission,
        source: { type: "tool", messageID: "message-1", callID: "" },
      })
    ).toEqual([unlinked])
  })

  it("keeps a permission's tool call, action, and resources through reconciliation", () => {
    const interactions = newInteractions()
    interactions.acceptPermission(scope, permission)
    expect(
      interactions.reconcile(scope, {
        questions: [],
        permissions: { data: [permission] },
      })
    ).toEqual([linkedPermission])
  })

  it("counts the resources a permission's message leaves out", () => {
    const long = "x".repeat(4_000)
    const [request] = newInteractions().acceptPermission(scope, {
      ...permission,
      resources: ["src/a.ts", long, "src/b.ts", "y".repeat(100)],
    })
    expect(request!.message).toBe(`src/a.ts\n${long}\nsrc/b.ts\n…(+1)`)
  })

  it("keeps a permission's message, and its count, within the text bound", () => {
    // The first two fit alone, but not with the count of the one left out.
    const long = "x".repeat(4_080)
    const [request] = newInteractions().acceptPermission(scope, {
      ...permission,
      resources: ["src/a.ts", long, "src/b.ts"],
    })
    expect(request!.message).toBe("src/a.ts\n…(+2)")
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
      interactions.respond({ ...scope, turnId: "reply-segment" }, [
        {
          requestId: "question-1",
          status: "resolved",
          payload: { answers: [["Yes"]] },
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
        requestId: "question-1",
        status: "resolved",
        payload: { answers: [["Yes"]] },
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
