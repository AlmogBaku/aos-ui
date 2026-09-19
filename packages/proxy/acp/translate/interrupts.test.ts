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

describe("pendingRequestToOutbound questions", () => {
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
          title: "Which environment?",
          description: "Which environment?",
        },
        q1: {
          type: "string",
          title: "Anything else to watch?",
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
          header: "Which environment?",
          prompt: "Which environment?",
          options: [{ label: "staging" }, { label: "production" }],
          multiple: false,
          custom: true,
        },
        {
          header: "Anything else to watch?",
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

    // The array accepts a value the question never listed, so a multi-select
    // answer may include the user's own text; the choices stay in `_meta.aos`.
    expect(fieldOf(outbound, "requestedSchema")).toEqual({
      type: "object",
      properties: {
        q0: {
          type: "array",
          title: "Pick the suites",
          description: "Pick the suites",
          items: { type: "string" },
        },
      },
      required: ["q0"],
    })
    expect(
      AosElicitationMetaSchema.parse(metaOf(outbound)).questions[0]
    ).toEqual({
      header: "Pick the suites",
      prompt: "Pick the suites",
      options: [{ label: "unit" }, { label: "e2e" }],
      multiple: true,
      custom: true,
    })
  })

  it("keeps an over-long question header inside the metadata contract", () => {
    const title = "w".repeat(600)
    const outbound = elicitationOf({
      id: "clarify-3",
      reason: "question",
      responseSchema: {
        properties: { answers: { prefixItems: [{ title, maxItems: 1 }] } },
      },
    })
    const meta = AosElicitationMetaSchema.parse(metaOf(outbound))

    expect(meta.questions[0]?.header).toHaveLength(256)
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
      replyFromElicitation(questions, {
        action: "accept",
        content: { q1: ["logs", "metrics"], q0: "production" },
      })
    ).toEqual({
      interruptId: "clarify-1",
      status: "resolved",
      payload: { answers: [["production"], ["logs", "metrics"]] },
    })
  })

  it("answers an unfilled field with an empty set", () => {
    expect(
      replyFromElicitation(questions, { action: "accept", content: { q0: "" } })
    ).toEqual({
      interruptId: "clarify-1",
      status: "resolved",
      payload: { answers: [[], []] },
    })
  })

  it.each([["decline"], ["cancel"]])(
    "cancels the interrupt on %s",
    (action) => {
      expect(replyFromElicitation(questions, { action })).toEqual({
        interruptId: "clarify-1",
        status: "cancelled",
      })
    }
  )
})
