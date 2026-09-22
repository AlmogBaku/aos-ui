import { describe, expect, it } from "vitest"

import {
  AOS_META_KEY,
  AOS_PERMISSION_KIND_SESSION,
  AosElicitationMetaSchema,
  AosPermissionMetaSchema,
} from "../../../protocol/acp"
import type { PendingRequest } from "../../core/events"
import type { AcpOutbound, Lane } from "../types"
import {
  answeredQuestionOutbound,
  pendingRequestToOutbound,
  replyFromElicitation,
  replyFromPermission,
} from "./interrupts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function permissionOf(request: PendingRequest, lane: Lane = "operator") {
  const outbound = pendingRequestToOutbound(request, lane)
  if (outbound.kind !== "request-permission")
    throw new Error(`expected a permission request, got ${outbound.kind}`)
  return outbound
}

function elicitationOf(request: PendingRequest, lane: Lane = "operator") {
  const outbound = pendingRequestToOutbound(request, lane)
  if (outbound.kind !== "elicitation")
    throw new Error(`expected an elicitation, got ${outbound.kind}`)
  return outbound
}

function metaOf(outbound: AcpOutbound): unknown {
  if (outbound.kind !== "request-permission" && outbound.kind !== "elicitation")
    throw new Error("not a pending request")
  const meta: unknown = outbound.request._meta
  return isRecord(meta) ? meta[AOS_META_KEY] : undefined
}

/** `AcpOutbound` narrows the elicitation mode away; read the form off the value. */
function fieldOf(outbound: AcpOutbound, name: string): unknown {
  if (outbound.kind !== "elicitation") throw new Error("not an elicitation")
  const request: unknown = outbound.request
  return isRecord(request) ? request[name] : undefined
}

/** The approval Hermes and OpenClaw raise: one choice from a public enum. */
const approval: PendingRequest = {
  id: "approval-1",
  reason: "approval",
  message: "Hermes wants to run `rm -rf build`.",
  toolCallId: "call-1",
  responseSchema: {
    type: "string",
    enum: ["once", "session", "always", "deny"],
  },
  expiresAt: "2026-09-19T10:00:00.000Z",
  metadata: { "aos.kind": "approval", "aos.scope": "run" },
}

/** The clarification Hermes raises: prefixed per-question answer schemas. */
const questions: PendingRequest = {
  id: "clarify-1",
  reason: "question",
  message: "2 questions require answers",
  responseSchema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        prefixItems: [
          {
            type: "array",
            title: "Which environment?",
            items: { type: "string", enum: ["staging", "production"] },
            minItems: 0,
            maxItems: 1,
          },
          {
            type: "array",
            title: "Anything else to watch?",
            items: { type: "string", maxLength: 4096 },
            minItems: 0,
            maxItems: 64,
          },
        ],
        minItems: 2,
        maxItems: 2,
      },
    },
    required: ["answers"],
    additionalProperties: false,
  },
  expiresAt: "2026-09-19T10:00:00.000Z",
}

describe("pendingRequestToOutbound approvals", () => {
  it("offers every adapter choice as its own permission option kind", () => {
    expect(permissionOf(approval).request.options).toEqual([
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "session",
        name: "Allow for this session",
        kind: AOS_PERMISSION_KIND_SESSION,
      },
      { optionId: "always", name: "Allow always", kind: "allow_always" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ])
  })

  it("withholds the wider scopes from a guest", () => {
    expect(
      permissionOf(approval, "guest").request.options.map(
        ({ optionId }) => optionId
      )
    ).toEqual(["once", "deny"])
  })

  it("names the pending tool call as the permission subject", () => {
    const { request } = permissionOf(approval)

    expect(request.title).toBe("Hermes wants to run `rm -rf build`.")
    expect(request.subject).toEqual({
      type: "tool_call",
      toolCall: {
        toolCallId: "call-1",
        title: "Hermes wants to run `rm -rf build`.",
        status: "pending",
      },
    })
  })

  it("carries the interrupt identity in parseable permission metadata", () => {
    expect(
      AosPermissionMetaSchema.parse(metaOf(permissionOf(approval)))
    ).toEqual({
      interruptId: "approval-1",
      expiresAt: "2026-09-19T10:00:00.000Z",
      message: "Hermes wants to run `rm -rf build`.",
    })
  })

  it("titles an approval that carries no message", () => {
    const outbound = permissionOf({
      id: "approval-2",
      reason: "approval",
      responseSchema: { type: "string", enum: ["once", "always", "deny"] },
    })

    expect(outbound.request.title).toBe("Permission required")
    expect(outbound.request.subject).toBeUndefined()
    expect(AosPermissionMetaSchema.parse(metaOf(outbound))).toEqual({
      interruptId: "approval-2",
    })
  })

  it("treats a confirmation like an approval", () => {
    expect(
      permissionOf({
        id: "approval-3",
        reason: "confirmation",
        responseSchema: { type: "string", enum: ["once", "deny"] },
      }).request.options
    ).toHaveLength(2)
  })
})

/** A clarification whose words name the operator's own machine. */
const located: PendingRequest = {
  id: "clarify-5",
  reason: "question",
  message: "Where should exports live? Not under /srv/aos/repo.",
  responseSchema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        prefixItems: [
          {
            type: "array",
            title: "Where should exports live? Not under /srv/aos/repo.",
            items: {
              type: "string",
              enum: ["/home/operator/exports (Recommended)", "ask later"],
            },
            minItems: 0,
            maxItems: 1,
          },
          {
            type: "array",
            title: "Anything else? See https://docs.example.test/exports",
            items: { type: "string", maxLength: 4096 },
            minItems: 0,
            maxItems: 1,
          },
        ],
        minItems: 2,
        maxItems: 2,
      },
    },
    required: ["answers"],
    additionalProperties: false,
  },
}

describe("pendingRequestToOutbound questions", () => {
  it("shows the operator the paths and URLs the agent wrote", () => {
    const meta = AosElicitationMetaSchema.parse(metaOf(elicitationOf(located)))
    expect(meta.questions[0]).toMatchObject({
      prompt: "Where should exports live? Not under /srv/aos/repo.",
      options: [
        { label: "/home/operator/exports (Recommended)" },
        { label: "ask later" },
      ],
    })
    expect(meta.questions[1]?.prompt).toBe(
      "Anything else? See https://docs.example.test/exports"
    )
  })

  it("keeps the operator's filesystem out of a guest's view, URLs included as prose", () => {
    const outbound = elicitationOf(located, "guest")
    const meta = AosElicitationMetaSchema.parse(metaOf(outbound))
    expect(fieldOf(outbound, "message")).toBe(
      "Where should exports live? Not under [provider path redacted]"
    )
    expect(meta.questions[0]).toMatchObject({
      prompt: "Where should exports live? Not under [provider path redacted]",
      options: [
        { label: "[provider path redacted] (Recommended)" },
        { label: "ask later" },
      ],
    })
    expect(meta.questions[1]?.prompt).toBe(
      "Anything else? See https://docs.example.test/exports"
    )
  })

  it("keeps prose slashes for a guest", () => {
    const meta = AosElicitationMetaSchema.parse(
      metaOf(
        elicitationOf(
          {
            ...located,
            message: "Post on X / twitter and/or 24/7?",
            responseSchema: {
              type: "object",
              properties: { answers: { type: "object" } },
            },
          },
          "guest"
        )
      )
    )
    expect(meta.questions[0]?.prompt).toBe("Post on X / twitter and/or 24/7?")
  })

  it("projects each prefixed answer schema into one form field", () => {
    const outbound = elicitationOf(questions)

    expect(fieldOf(outbound, "mode")).toBe("form")
    expect(fieldOf(outbound, "message")).toBe("2 questions require answers")
    // No `enum`: a clarify answer may be free text that is none of the offered
    // choices, which an enumerated property would reject.
    expect(fieldOf(outbound, "requestedSchema")).toEqual({
      type: "object",
      properties: {
        q0: {
          type: "string",
          title: "Question 1",
          description: "Which environment?",
        },
        q1: {
          type: "string",
          title: "Question 2",
          description: "Anything else to watch?",
        },
      },
      required: ["q0", "q1"],
    })
  })

  it("keeps the questions losslessly in parseable elicitation metadata", () => {
    // Every question is `custom`: the native contract always offers an
    // "Other (type your answer)" row beside the choices it lists.
    expect(
      AosElicitationMetaSchema.parse(metaOf(elicitationOf(questions)))
    ).toEqual({
      interruptId: "clarify-1",
      expiresAt: "2026-09-19T10:00:00.000Z",
      questions: [
        {
          header: "Question 1",
          prompt: "Which environment?",
          options: [{ label: "staging" }, { label: "production" }],
          multiple: false,
          custom: true,
        },
        {
          header: "Question 2",
          prompt: "Anything else to watch?",
          options: [],
          multiple: true,
          custom: true,
        },
      ],
    })
  })

  it("offers a multi-choice question as a multi-select field", () => {
    const outbound = elicitationOf({
      id: "clarify-2",
      reason: "question",
      responseSchema: {
        type: "object",
        properties: {
          answers: {
            prefixItems: [
              {
                title: "Pick the suites",
                items: { type: "string", enum: ["unit", "e2e"] },
                maxItems: 2,
              },
            ],
          },
        },
      },
    })

    // ACP requires a `"string"` item type to declare its `enum`, and the
    // response schema never constrains an answer to it, so the user's own text
    // still travels while a foreign client can still render the choices.
    expect(fieldOf(outbound, "requestedSchema")).toEqual({
      type: "object",
      properties: {
        q0: {
          type: "array",
          title: "Question",
          description: "Pick the suites",
          items: { type: "string", enum: ["unit", "e2e"] },
        },
      },
      required: ["q0"],
    })
    expect(
      AosElicitationMetaSchema.parse(metaOf(outbound)).questions[0]
    ).toEqual({
      header: "Question",
      prompt: "Pick the suites",
      options: [{ label: "unit" }, { label: "e2e" }],
      multiple: true,
      custom: true,
    })
  })

  it("labels a question by its place, because clarify carries no short title", () => {
    // Hermes Desktop heads each question with its full text; the AOS tab strip
    // has room only for a label, so the number is the label and the prompt
    // keeps every word.
    const title = "w".repeat(600)
    const outbound = elicitationOf({
      id: "clarify-3",
      reason: "question",
      responseSchema: {
        properties: { answers: { prefixItems: [{ title, maxItems: 1 }] } },
      },
    })
    const meta = AosElicitationMetaSchema.parse(metaOf(outbound))

    expect(meta.questions[0]?.header).toBe("Question")
    expect(meta.questions[0]?.prompt).toBe(title)
  })

  it("asks one free-text question when the schema lists no answer fields", () => {
    const outbound = elicitationOf({
      id: "clarify-4",
      reason: "question",
      message: "Which branch should I use?",
      responseSchema: {
        type: "object",
        properties: { answers: { type: "object" } },
        required: ["answers"],
      },
    })

    expect(AosElicitationMetaSchema.parse(metaOf(outbound)).questions).toEqual([
      {
        header: "Question",
        prompt: "Which branch should I use?",
        options: [],
        multiple: false,
        custom: true,
      },
    ])
  })
})

describe("replyFromPermission", () => {
  it("resolves with the adapter's own choice value", () => {
    expect(
      replyFromPermission(approval, {
        outcome: { outcome: "selected", optionId: "session" },
      })
    ).toEqual({
      interruptId: "approval-1",
      status: "resolved",
      payload: "session",
    })
  })

  it.each([
    ["a cancelled prompt", { outcome: "cancelled" }],
    ["an unknown outcome", { outcome: "_dismissed" }],
  ])("cancels the interrupt on %s", (_label, outcome) => {
    expect(replyFromPermission(approval, { outcome })).toEqual({
      interruptId: "approval-1",
      status: "cancelled",
    })
  })
})

describe("replyFromElicitation", () => {
  it("rebuilds the answer sets in question order", () => {
    expect(
      replyFromElicitation(
        questions,
        {
          action: "accept",
          content: { q1: ["logs", "metrics"], q0: "production" },
        },
        "operator"
      )
    ).toEqual({
      interruptId: "clarify-1",
      status: "resolved",
      payload: { answers: [["production"], ["logs", "metrics"]] },
    })
  })

  it("answers the native choice a guest's projected label stood for", () => {
    const reply = replyFromElicitation(
      located,
      {
        action: "accept",
        content: {
          q0: "[provider path redacted] (Recommended)",
          q1: "just keep it in the repo",
        },
      },
      "guest"
    )
    expect(reply).toEqual({
      interruptId: "clarify-5",
      status: "resolved",
      payload: {
        answers: [
          ["/home/operator/exports (Recommended)"],
          ["just keep it in the repo"],
        ],
      },
    })
  })

  it("answers an unfilled field with an empty set", () => {
    expect(
      replyFromElicitation(
        questions,
        { action: "accept", content: { q0: "" } },
        "operator"
      )
    ).toEqual({
      interruptId: "clarify-1",
      status: "resolved",
      payload: { answers: [[], []] },
    })
  })

  it.each([["decline"], ["cancel"]])(
    "cancels the interrupt on %s",
    (action) => {
      expect(replyFromElicitation(questions, { action }, "operator")).toEqual({
        interruptId: "clarify-1",
        status: "cancelled",
      })
    }
  )
})

describe("answeredQuestionOutbound", () => {
  /** The same clarification, raised by a provider that names its tool call. */
  const asking: PendingRequest = { ...questions, toolCallId: "call-7" }

  it("records every value the operator chose against the question it answers", () => {
    expect(
      answeredQuestionOutbound(
        asking,
        {
          action: "accept",
          content: { q0: "production", q1: ["logs", "metrics"] },
        },
        "operator"
      )
    ).toEqual({
      kind: "update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-7",
        status: "completed",
        rawOutput: {
          status: "answered",
          responses: [
            { question: "Which environment?", answers: ["production"] },
            {
              question: "Anything else to watch?",
              answers: ["logs", "metrics"],
            },
          ],
        },
      },
    })
  })

  it("records a declined question as an answer nobody gave", () => {
    expect(
      answeredQuestionOutbound(asking, { action: "decline" }, "operator")
    ).toEqual({
      kind: "update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-7",
        status: "completed",
        rawOutput: {
          status: "cancelled",
          responses: [
            { question: "Which environment?", answers: [] },
            { question: "Anything else to watch?", answers: [] },
          ],
        },
      },
    })
  })

  it("leaves no record when the interrupt names no tool call", () => {
    expect(
      answeredQuestionOutbound(
        questions,
        {
          action: "accept",
          content: { q0: "production" },
        },
        "operator"
      )
    ).toBeUndefined()
  })
})
