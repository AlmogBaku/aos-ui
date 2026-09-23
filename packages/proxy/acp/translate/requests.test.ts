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
} from "./requests"

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
  requestId: "approval-1",
  kind: "permission",
  message: "Hermes wants to run `rm -rf build`.",
  toolCallId: "call-1",
  responseSchema: {
    type: "string",
    enum: ["once", "session", "always", "deny"],
  },
  expiresAt: "2026-09-19T10:00:00.000Z",
}

/** The clarification Hermes raises: a choice and a free-text question. */
const questions: PendingRequest = {
  requestId: "clarify-1",
  kind: "elicitation",
  message: "2 questions require answers",
  questions: [
    {
      text: "Which environment?",
      choices: ["staging", "production"],
      multiple: false,
      custom: true,
    },
    {
      text: "Anything else to watch?",
      choices: [],
      multiple: true,
      custom: true,
    },
  ],
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

  it("titles a permission with the operation and describes it with the message", () => {
    const { request } = permissionOf({
      ...approval,
      message: "Write to protected agent-instruction file(s): AGENTS.md.",
      responseSchema: {
        ...approval.responseSchema,
        title: "<write to AGENTS.md>",
      },
    })

    expect(request.title).toBe("<write to AGENTS.md>")
    expect(request.description).toBe(
      "Write to protected agent-instruction file(s): AGENTS.md."
    )
  })

  it("carries the request identity in parseable permission metadata", () => {
    expect(
      AosPermissionMetaSchema.parse(metaOf(permissionOf(approval)))
    ).toEqual({
      requestId: "approval-1",
      expiresAt: "2026-09-19T10:00:00.000Z",
      message: "Hermes wants to run `rm -rf build`.",
    })
  })

  it("titles an approval that carries no message", () => {
    const outbound = permissionOf({
      requestId: "approval-2",
      kind: "permission",
      responseSchema: { type: "string", enum: ["once", "always", "deny"] },
    })

    expect(outbound.request.title).toBe("Permission required")
    expect(outbound.request.subject).toBeUndefined()
    expect(AosPermissionMetaSchema.parse(metaOf(outbound))).toEqual({
      requestId: "approval-2",
    })
  })
})

/** A clarification whose words name the operator's own machine. */
const located: PendingRequest = {
  requestId: "clarify-5",
  kind: "elicitation",
  message: "Where should exports live? Not under /srv/aos/repo.",
  questions: [
    {
      text: "Where should exports live? Not under /srv/aos/repo.",
      choices: ["/home/operator/exports (Recommended)", "ask later"],
      multiple: false,
      custom: true,
    },
    {
      text: "Anything else? See https://docs.example.test/exports",
      choices: [],
      multiple: false,
      custom: true,
    },
  ],
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
            requestId: "clarify-9",
            kind: "elicitation",
            message: "Post on X / twitter and/or 24/7?",
          },
          "guest"
        )
      )
    )
    expect(meta.questions[0]?.prompt).toBe("Post on X / twitter and/or 24/7?")
  })

  it("projects each question into one form field", () => {
    const outbound = elicitationOf(questions)

    expect(fieldOf(outbound, "mode")).toBe("form")
    expect(fieldOf(outbound, "message")).toBe("2 questions require answers")
    // No `enum`: a clarify answer may be free text that is none of the offered
    // choices, which an enumerated property would reject.
    expect(fieldOf(outbound, "requestedSchema")).toEqual({
      type: "object",
      properties: {
        q0: { type: "string", description: "Which environment?" },
        q1: { type: "string", description: "Anything else to watch?" },
      },
      required: ["q0", "q1"],
    })
  })

  it("keeps the questions losslessly in parseable elicitation metadata", () => {
    expect(
      AosElicitationMetaSchema.parse(metaOf(elicitationOf(questions)))
    ).toEqual({
      requestId: "clarify-1",
      expiresAt: "2026-09-19T10:00:00.000Z",
      questions: [
        {
          prompt: "Which environment?",
          options: [{ label: "staging" }, { label: "production" }],
          multiple: false,
          custom: true,
        },
        {
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
      requestId: "clarify-2",
      kind: "elicitation",
      questions: [
        {
          text: "Pick the suites",
          choices: ["unit", "e2e"],
          multiple: true,
          custom: true,
        },
      ],
    })

    // ACP requires a `"string"` item type to declare its `enum`, and the
    // response schema never constrains an answer to it, so the user's own text
    // still travels while a foreign client can still render the choices.
    expect(fieldOf(outbound, "requestedSchema")).toEqual({
      type: "object",
      properties: {
        q0: {
          type: "array",
          description: "Pick the suites",
          items: { type: "string", enum: ["unit", "e2e"] },
        },
      },
      required: ["q0"],
    })
    expect(
      AosElicitationMetaSchema.parse(metaOf(outbound)).questions[0]
    ).toEqual({
      prompt: "Pick the suites",
      options: [{ label: "unit" }, { label: "e2e" }],
      multiple: true,
      custom: true,
    })
  })

  it("leaves a question the provider did not label for the browser to name", () => {
    // `clarify` carries the question's words and no short label. Numbering it
    // here would send English to a Hebrew reader, so the header stays unset
    // and the browser, which knows the locale, supplies the label.
    const description = "w".repeat(600)
    const outbound = elicitationOf({
      requestId: "clarify-3",
      kind: "elicitation",
      questions: [
        { text: description, choices: [], multiple: false, custom: true },
      ],
    })
    const meta = AosElicitationMetaSchema.parse(metaOf(outbound))

    expect(meta.questions[0]?.header).toBeUndefined()
    expect(meta.questions[0]?.prompt).toBe(description)
  })

  it("heads a question with the short label its provider supplied", () => {
    const outbound = elicitationOf({
      requestId: "clarify-6",
      kind: "elicitation",
      questions: [
        {
          label: "Region",
          text: "Which region should the export land in?",
          choices: ["eu", "us"],
          multiple: false,
          custom: true,
        },
      ],
    })
    const meta = AosElicitationMetaSchema.parse(metaOf(outbound))

    expect(meta.questions[0]).toEqual({
      header: "Region",
      prompt: "Which region should the export land in?",
      options: [{ label: "eu" }, { label: "us" }],
      multiple: false,
      custom: true,
    })
    expect(fieldOf(outbound, "requestedSchema")).toMatchObject({
      properties: {
        q0: {
          title: "Region",
          description: "Which region should the export land in?",
        },
      },
    })
  })

  it("keeps a provider's overlong label inside the header bound", () => {
    const meta = AosElicitationMetaSchema.parse(
      metaOf(
        elicitationOf({
          requestId: "clarify-7",
          kind: "elicitation",
          questions: [
            {
              label: "w".repeat(600),
              choices: [],
              multiple: false,
              custom: true,
            },
          ],
        })
      )
    )

    expect(meta.questions[0]?.header).toBe("w".repeat(256))
  })

  it("redacts a guest's view of a label that names the operator's machine", () => {
    const meta = AosElicitationMetaSchema.parse(
      metaOf(
        elicitationOf(
          {
            requestId: "clarify-8",
            kind: "elicitation",
            questions: [
              {
                label: "Under /srv/aos/repo?",
                choices: [],
                multiple: false,
                custom: true,
              },
            ],
          },
          "guest"
        )
      )
    )

    expect(meta.questions[0]?.header).toBe("Under [provider path redacted]")
  })

  it("offers only the choices of a question that takes no free text", () => {
    const meta = AosElicitationMetaSchema.parse(
      metaOf(
        elicitationOf({
          requestId: "clarify-10",
          kind: "elicitation",
          questions: [
            {
              label: "Deploy",
              text: "Deploy now?",
              choices: ["yes", "no"],
              multiple: false,
              custom: false,
            },
          ],
        })
      )
    )

    expect(meta.questions[0]).toMatchObject({
      options: [{ label: "yes" }, { label: "no" }],
      custom: false,
    })
  })

  it("asks one free-text question when the request lists none", () => {
    const outbound = elicitationOf({
      requestId: "clarify-4",
      kind: "elicitation",
      message: "Which branch should I use?",
    })

    expect(AosElicitationMetaSchema.parse(metaOf(outbound)).questions).toEqual([
      {
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
      requestId: "approval-1",
      status: "resolved",
      payload: "session",
    })
  })

  it.each([
    ["a cancelled prompt", { outcome: "cancelled" }],
    ["an unknown outcome", { outcome: "_dismissed" }],
  ])("cancels the request on %s", (_label, outcome) => {
    expect(replyFromPermission(approval, { outcome })).toEqual({
      requestId: "approval-1",
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
      requestId: "clarify-1",
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
      requestId: "clarify-5",
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
      requestId: "clarify-1",
      status: "resolved",
      payload: { answers: [[], []] },
    })
  })

  it.each([["decline"], ["cancel"]])("cancels the request on %s", (action) => {
    expect(replyFromElicitation(questions, { action }, "operator")).toEqual({
      requestId: "clarify-1",
      status: "cancelled",
    })
  })
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

  it("leaves no record when the request names no tool call", () => {
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
