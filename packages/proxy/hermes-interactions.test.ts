import { describe, expect, it, vi } from "vitest"

import { HermesInteractions } from "./hermes-interactions"

const scope = {
  agentId: "research",
  sessionId: "session-1",
  threadId: "session-1",
  runId: "run-1",
}

describe("HermesInteractions", () => {
  it("normalizes a native approval as a run-bound AG-UI interrupt", () => {
    const request = vi.fn()
    const interactions = new HermesInteractions({ request })

    const outcome = interactions.acceptNative(scope, "live-private", {
      type: "approval.request",
      session_id: "live-private",
      payload: {
        request_id: "approval-1",
        command: "deploy production",
        choices: ["deny", "once", "always"],
        allow_permanent: false,
      },
    })

    expect(outcome).toEqual({
      type: "interrupt",
      interrupts: [
        {
          id: "approval-1",
          reason: "approval",
          message: "deploy production",
          responseSchema: {
            type: "string",
            enum: ["deny", "once"],
          },
          metadata: {
            "aos.kind": "approval",
            "aos.scope": "run",
            "aos.choiceScopes": {
              deny: "request",
              once: "request",
            },
          },
        },
      ],
    })
    expect(JSON.stringify(outcome)).not.toContain("live-private")
  })

  it("uses the existing safe fallback for an approval without display text", () => {
    const interactions = new HermesInteractions({ request: vi.fn() })

    expect(
      interactions.acceptNative(scope, "live-private", {
        type: "approval.request",
        session_id: "live-private",
        payload: { request_id: "approval-untitled" },
      })
    ).toMatchObject({
      interrupts: [
        {
          id: "approval-untitled",
          message: "Hermes is requesting permission to continue.",
        },
      ],
    })
  })

  it("normalizes ordered native clarification questions without exposing question wire ids", () => {
    const interactions = new HermesInteractions({ request: vi.fn() })

    const outcome = interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: {
        request_id: "clarify-1",
        questions: [
          {
            qid: "native-q2",
            question: "Which region?",
            choices: ["eu", "us"],
            multi_select: false,
          },
          {
            qid: "native-q1",
            question: "Which checks?",
            choices: ["smoke", "e2e"],
            multi_select: true,
          },
        ],
      },
    })

    expect(outcome).toEqual({
      type: "interrupt",
      interrupts: [
        {
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
                    title: "Which region?",
                    items: { type: "string", enum: ["eu", "us"] },
                    minItems: 0,
                    maxItems: 1,
                  },
                  {
                    type: "array",
                    title: "Which checks?",
                    items: { type: "string", enum: ["smoke", "e2e"] },
                    minItems: 0,
                    maxItems: 2,
                    uniqueItems: true,
                  },
                ],
                minItems: 2,
                maxItems: 2,
              },
            },
            required: ["answers"],
            additionalProperties: false,
          },
          metadata: {
            "aos.kind": "questions",
            "aos.scope": "run",
            "aos.questionCount": 2,
          },
        },
      ],
    })
    expect(JSON.stringify(outcome)).not.toMatch(/live-private|native-q/)
  })

  it("rejects malformed and oversized recognized native interaction payloads safely", () => {
    const interactions = new HermesInteractions({ request: vi.fn() })
    const malformed = {
      type: "clarify.request",
      session_id: "live-private",
      payload: {
        request_id: "clarify-1",
        questions: [{ qid: "q0", question: "?", multi_select: "yes" }],
        provider_url: "https://hermes.internal",
      },
    }

    let malformedError: unknown
    try {
      interactions.acceptNative(scope, "live-private", malformed)
    } catch (error) {
      malformedError = error
    }
    expect(malformedError).toMatchObject({
      name: "HermesInteractionPublicError",
      code: "AOS_PROVIDER_INVALID_RESPONSE",
      message: "Hermes returned invalid interaction data",
    })
    let oversizedError: unknown
    try {
      interactions.acceptNative(scope, "live-private", {
        type: "approval.request",
        session_id: "live-private",
        payload: {
          request_id: "approval-2",
          command: "x".repeat(70_000),
        },
      })
    } catch (error) {
      oversizedError = error
    }
    expect(oversizedError).toMatchObject({
      code: "AOS_PROVIDER_INVALID_RESPONSE",
    })
  })

  it("responds to an approval once with its private native binding and makes replay idempotent", async () => {
    const request = vi.fn().mockResolvedValue({ resolved: 1 })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "approval.request",
      session_id: "live-private",
      payload: { request_id: "approval-1", command: "deploy" },
    })

    await expect(
      interactions.respond(scope, {
        interruptId: "approval-1",
        status: "resolved",
        payload: "session",
      })
    ).resolves.toEqual({ status: "resolved" })
    await expect(
      interactions.respond(scope, {
        interruptId: "approval-1",
        status: "resolved",
        payload: "session",
      })
    ).resolves.toEqual({ status: "already-resolved" })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith("approval.respond", {
      session_id: "live-private",
      request_id: "approval-1",
      choice: "session",
    })
  })

  it("treats the existing Hermes boolean response fixtures as successful acknowledgements", async () => {
    const request = vi.fn().mockResolvedValue({ resolved: true })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "approval.request",
      session_id: "live-private",
      payload: { id: "approval-from-id", command: "deploy" },
    })

    await expect(
      interactions.respond(scope, {
        interruptId: "approval-from-id",
        status: "resolved",
        payload: "once",
        metadata: { presentation: { selectedBy: "keyboard" } },
      })
    ).resolves.toEqual({ status: "resolved" })
    expect(request).toHaveBeenCalledWith("approval.respond", {
      session_id: "live-private",
      request_id: "approval-from-id",
      choice: "once",
    })

    request.mockResolvedValue({ resolved: true })
    interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: { request_id: "clarify-fixture", question: "Continue?" },
    })
    await expect(
      interactions.respond(scope, {
        interruptId: "clarify-fixture",
        status: "resolved",
        payload: { answers: [["yes"]] },
        metadata: { ignored: true },
      })
    ).resolves.toEqual({ status: "resolved" })
  })

  it("preserves exact native clarification choices and free-text answer whitespace", async () => {
    const request = vi.fn().mockResolvedValue({ resolved: true })
    const interactions = new HermesInteractions({ request })
    const outcome = interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: {
        request_id: "clarify-whitespace",
        questions: [
          {
            qid: "choice",
            question: "Pick exact",
            choices: ["  padded choice  ", "plain"],
            multi_select: false,
          },
          {
            qid: "free",
            question: "Free text",
            choices: null,
            multi_select: false,
          },
        ],
      },
    })
    expect(
      outcome &&
        "interrupts" in outcome &&
        outcome.interrupts[0]?.responseSchema?.properties
    ).toMatchObject({
      answers: {
        prefixItems: [
          { items: { enum: ["  padded choice  ", "plain"] } },
          { items: { type: "string" } },
        ],
      },
    })

    await interactions.respond(scope, {
      interruptId: "clarify-whitespace",
      status: "resolved",
      payload: { answers: [["  padded choice  "], ["  free text  "]] },
    })
    expect(request.mock.calls).toEqual([
      [
        "clarify.respond",
        {
          session_id: "live-private",
          request_id: "clarify-whitespace",
          question_id: "choice",
          answer: "  padded choice  ",
        },
      ],
      [
        "clarify.respond",
        {
          session_id: "live-private",
          request_id: "clarify-whitespace",
          question_id: "free",
          answer: "  free text  ",
        },
      ],
    ])
  })

  it("rejects cross-Agent, cross-Session, and cross-run interaction substitution", async () => {
    const request = vi.fn().mockResolvedValue({ resolved: 1 })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "approval.request",
      session_id: "live-private",
      payload: { request_id: "approval-1", command: "deploy" },
    })
    const resume = {
      interruptId: "approval-1",
      status: "resolved",
      payload: "once",
    }

    for (const changed of [
      { ...scope, agentId: "other" },
      { ...scope, sessionId: "other", threadId: "other" },
      { ...scope, runId: "other" },
    ]) {
      await expect(interactions.respond(changed, resume)).rejects.toMatchObject(
        {
          code: "AOS_INTERACTION_NOT_FOUND",
          message: "Interaction not found",
        }
      )
    }
    expect(request).not.toHaveBeenCalled()
  })

  it("sends ordered clarification answers with exact single and multi-select semantics", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: "ok", remaining: ["q1"] })
      .mockResolvedValueOnce({ status: "ok", remaining: [] })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: {
        request_id: "clarify-1",
        questions: [
          {
            qid: "q0",
            question: "Region?",
            choices: ["eu", "us"],
            multi_select: false,
          },
          {
            qid: "q1",
            question: "Checks?",
            choices: ["smoke", "e2e"],
            multi_select: true,
          },
        ],
      },
    })

    await expect(
      interactions.respond(scope, {
        interruptId: "clarify-1",
        status: "resolved",
        payload: { answers: [["eu"], ["smoke", "e2e"]] },
      })
    ).resolves.toEqual({ status: "resolved" })
    expect(request.mock.calls).toEqual([
      [
        "clarify.respond",
        {
          session_id: "live-private",
          request_id: "clarify-1",
          question_id: "q0",
          answer: "eu",
        },
      ],
      [
        "clarify.respond",
        {
          session_id: "live-private",
          request_id: "clarify-1",
          question_id: "q1",
          answer: '["smoke","e2e"]',
        },
      ],
    ])
  })

  it("uses Hermes' native cancellation semantics for questions and available approval denial", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: "ok", remaining: [] })
      .mockResolvedValueOnce({ resolved: 1 })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: { request_id: "clarify-1", question: "Proceed?" },
    })
    await interactions.respond(scope, {
      interruptId: "clarify-1",
      status: "cancelled",
    })
    interactions.acceptNative(scope, "live-private", {
      type: "approval.request",
      session_id: "live-private",
      payload: { request_id: "approval-1", command: "deploy" },
    })
    await interactions.respond(scope, {
      interruptId: "approval-1",
      status: "cancelled",
    })

    expect(request.mock.calls).toEqual([
      [
        "clarify.respond",
        {
          session_id: "live-private",
          request_id: "clarify-1",
          answer: "",
        },
      ],
      [
        "approval.respond",
        {
          session_id: "live-private",
          request_id: "approval-1",
          choice: "deny",
        },
      ],
    ])
  })

  it("rejects malformed answers and returns a redacted uncertain result after an outage without replay", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "connect https://hermes.internal token=super-secret /home/agent"
        )
      )
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: {
        request_id: "clarify-1",
        question: "Region?",
        choices: ["eu", "us"],
      },
    })

    await expect(
      interactions.respond(scope, {
        interruptId: "clarify-1",
        status: "resolved",
        payload: { answers: [["moon"]] },
      })
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    await expect(
      interactions.respond(scope, {
        interruptId: "clarify-1",
        status: "resolved",
        payload: { answers: [["eu"]] },
      })
    ).resolves.toEqual({ status: "uncertain" })
    await expect(
      interactions.respond(scope, {
        interruptId: "clarify-1",
        status: "resolved",
        payload: { answers: [["eu"]] },
      })
    ).resolves.toEqual({ status: "uncertain" })
    expect(request).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await interactions.pending(scope))).not.toMatch(
      /hermes\.internal|super-secret|\/home\/agent|live-private/
    )
  })

  it("authoritatively restores pending interactions on resume without disclosing the live Session id", async () => {
    const request = vi.fn().mockResolvedValue({
      session_id: "live-private-2",
      running: true,
      status: "running",
      pending_approval: {
        request_id: "approval-2",
        description: "Restart deployment",
        smart_denied: true,
      },
      pending_clarify: {
        request_id: "clarify-2",
        question: "Region?",
        choices: ["eu", "us"],
        multi_select: false,
      },
      provider_url: "https://hermes.internal",
    })
    const interactions = new HermesInteractions({ request })

    const resumed = await interactions.resume(scope)

    expect(request).toHaveBeenCalledWith("session.resume", {
      session_id: "session-1",
      profile: "research",
      omit_messages: true,
    })
    expect(resumed).toMatchObject({
      running: true,
      status: "waiting-for-input",
      outcome: {
        type: "interrupt",
        interrupts: [
          { id: "approval-2", reason: "approval" },
          { id: "clarify-2", reason: "question" },
        ],
      },
    })
    expect(JSON.stringify(resumed)).not.toMatch(
      /live-private|hermes\.internal|provider_url/
    )
  })

  it("projects resume outages and malformed native results with safe typed errors", async () => {
    const secret = "token=secret https://hermes.internal /home/operator"
    const outage = new HermesInteractions({
      request: vi.fn().mockRejectedValue(new Error(secret)),
    })
    await expect(outage.resume(scope)).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable",
    })

    const malformed = new HermesInteractions({
      request: vi.fn().mockResolvedValue({
        session_id: "live-private",
        running: "yes",
        pending_clarify: { request_id: "x", question: { path: secret } },
      }),
    })
    await expect(malformed.resume(scope)).rejects.toMatchObject({
      code: "AOS_PROVIDER_INVALID_RESPONSE",
      message: "Hermes returned invalid interaction data",
    })
  })

  it("expires only the clarification bound to the native Session and run", async () => {
    const interactions = new HermesInteractions({ request: vi.fn() })
    interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: { request_id: "clarify-1", question: "Region?" },
    })

    expect(
      interactions.acceptNative(scope, "other-live", {
        type: "clarify.expire",
        session_id: "live-private",
        payload: { request_id: "clarify-1" },
      })
    ).toBeUndefined()
    expect(interactions.pending(scope)).toHaveLength(1)
    expect(
      interactions.acceptNative(scope, "live-private", {
        type: "clarify.expire",
        session_id: "live-private",
        payload: { request_id: "clarify-1" },
      })
    ).toEqual({ status: "expired" })
    expect(interactions.pending(scope)).toEqual([])
  })

  it("reports operation-specific interaction capabilities with choices, scopes, limits, and limitations", () => {
    const interactions = new HermesInteractions({ request: vi.fn() })

    expect(interactions.capabilities()).toEqual({
      approvals: {
        status: "available",
        protocol: "ag-ui-interrupt",
        scope: "run",
        choices: [
          { value: "once", scope: "request" },
          { value: "session", scope: "session" },
          { value: "always", scope: "agent" },
          { value: "deny", scope: "request" },
        ],
        maxPending: 64,
      },
      questions: {
        status: "available",
        protocol: "ag-ui-interrupt",
        scope: "run",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-empty-answer",
        maxQuestions: 32,
        maxChoicesPerQuestion: 64,
        maxAnswerValuesPerQuestion: 64,
        maxStringBytes: 4096,
      },
      reactions: {
        status: "unavailable",
        reason: "native-reaction-operation-unavailable",
      },
    })
    expect(
      (interactions as unknown as { react?: unknown }).react
    ).toBeUndefined()
  })

  it("redacts native credentials, URLs, and filesystem paths while mapping a selected display choice back exactly", async () => {
    const request = vi.fn().mockResolvedValue({ resolved: true })
    const interactions = new HermesInteractions({ request })

    const outcome = interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: {
        request_id: "clarify-safe",
        question:
          "Use Authorization: Bearer plain-private-token and token=super-secret from /project/key, then C:/Users/operator/key; inspect:/opt/private/key or C:\\Users\\operator\\key at wss://hermes.internal/ws?code=x?",
        choices: ["/srv/private/a", "file:///tmp/key"],
      },
    })

    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toMatch(
      /plain-private-token|super-secret|\/project\/key|C:[\\/]Users|\/opt\/private|\/srv\/private|hermes\.internal|\/tmp\/key/
    )
    expect(serialized).toContain("[credential redacted]")
    expect(serialized).toContain("[provider path redacted]")
    expect(serialized).toContain("[provider location redacted]")
    const properties =
      outcome && "interrupts" in outcome
        ? (outcome.interrupts[0]?.responseSchema?.properties as {
            answers: {
              prefixItems: Array<{ items: { enum: string[] } }>
            }
          })
        : undefined
    const displayedChoice = properties?.answers.prefixItems[0]?.items.enum[0]
    await interactions.respond(scope, {
      interruptId: "clarify-safe",
      status: "resolved",
      payload: { answers: [[displayedChoice]] },
    })
    expect(request).toHaveBeenCalledWith("clarify.respond", {
      session_id: "live-private",
      request_id: "clarify-safe",
      answer: "/srv/private/a",
    })
  })

  it("prevents a concurrent response and rejects changed payloads on replay", async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "approval.request",
      session_id: "live-private",
      payload: { request_id: "approval-1", command: "deploy" },
    })
    const original = {
      interruptId: "approval-1",
      status: "resolved",
      payload: "once",
    }
    const first = interactions.respond(scope, original)

    await expect(interactions.respond(scope, original)).resolves.toEqual({
      status: "in-progress",
    })
    finish({ resolved: 1 })
    await expect(first).resolves.toEqual({ status: "resolved" })
    await expect(
      interactions.respond(scope, { ...original, payload: "deny" })
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("enforces question count, nesting, and answer byte limits", async () => {
    const interactions = new HermesInteractions({ request: vi.fn() })
    expect(() =>
      interactions.acceptNative(scope, "live-private", {
        type: "clarify.request",
        session_id: "live-private",
        payload: {
          request_id: "too-many",
          questions: Array.from({ length: 33 }, (_, index) => ({
            qid: `q${index}`,
            question: "Question?",
            choices: null,
            multi_select: false,
          })),
        },
      })
    ).toThrowError("Hermes returned invalid interaction data")

    interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: { request_id: "bounded", question: "Answer?" },
    })
    await expect(
      interactions.respond(scope, {
        interruptId: "bounded",
        status: "resolved",
        payload: { answers: [["x".repeat(4097)]] },
      })
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
  })

  it("does not reopen a completed interaction from a duplicate live event", async () => {
    const request = vi.fn().mockResolvedValue({ resolved: 1 })
    const interactions = new HermesInteractions({ request })
    const event = {
      type: "approval.request",
      session_id: "live-private",
      payload: { request_id: "approval-1", command: "deploy" },
    }
    interactions.acceptNative(scope, "live-private", event)
    await interactions.respond(scope, {
      interruptId: "approval-1",
      status: "resolved",
      payload: "once",
    })

    expect(
      interactions.acceptNative(scope, "live-private", event)
    ).toBeUndefined()
    expect(interactions.pending(scope)).toEqual([])
  })

  it("authoritatively restores an id-only pending approval after completion", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "live-private-2",
          running: true,
          pending_approval: { id: "approval-1", command: "deploy again" },
        }
      return { resolved: true }
    })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "approval.request",
      session_id: "live-private",
      payload: { id: "approval-1", command: "deploy" },
    })
    await interactions.respond(scope, {
      interruptId: "approval-1",
      status: "resolved",
      payload: "once",
    })

    const resumed = await interactions.resume(scope)

    expect(resumed.outcome).toMatchObject({
      interrupts: [{ id: "approval-1", message: "deploy again" }],
    })
    await expect(
      interactions.respond(scope, {
        interruptId: "approval-1",
        status: "resolved",
        payload: "once",
      })
    ).resolves.toEqual({ status: "resolved" })
    expect(
      request.mock.calls.filter(([method]) => method === "approval.respond")
    ).toHaveLength(2)
  })

  it("restores already locked batch answers as safe ordered schema defaults", async () => {
    const interactions = new HermesInteractions({
      request: vi.fn().mockResolvedValue({
        session_id: "live-private",
        running: true,
        pending_clarify: {
          request_id: "clarify-locked",
          questions: [
            {
              qid: "q0",
              question: "Region?",
              choices: ["eu", "us"],
              multi_select: false,
            },
            {
              qid: "q1",
              question: "Checks?",
              choices: ["smoke", "e2e"],
              multi_select: true,
            },
          ],
          answers: { q0: "eu", q1: '["smoke"]' },
        },
      }),
    })

    const resumed = await interactions.resume(scope)
    const interrupt = resumed.outcome?.interrupts[0]
    expect(interrupt?.metadata).toMatchObject({
      "aos.lockedAnswerIndexes": [0, 1],
    })
    expect(
      (
        interrupt?.responseSchema?.properties as {
          answers: { prefixItems: Array<{ default?: string[] }> }
        }
      ).answers.prefixItems.map((item) => item.default)
    ).toEqual([["eu"], ["smoke"]])
  })

  it("does not overwrite a locked sensitive free-text answer with its public redaction", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        session_id: "live-private",
        running: true,
        pending_clarify: {
          request_id: "clarify-locked",
          questions: [
            {
              qid: "q0",
              question: "Existing path?",
              choices: null,
              multi_select: false,
            },
            {
              qid: "q1",
              question: "Region?",
              choices: ["eu", "us"],
              multi_select: false,
            },
          ],
          answers: { q0: "/home/operator/secret" },
        },
      })
      .mockResolvedValueOnce({ status: "ok", remaining: [] })
    const interactions = new HermesInteractions({ request })
    const resumed = await interactions.resume(scope)
    const schema = resumed.outcome?.interrupts[0]?.responseSchema as {
      properties: { answers: { prefixItems: Array<{ default?: string[] }> } }
    }
    const redacted = schema.properties.answers.prefixItems[0]!.default!

    await interactions.respond(scope, {
      interruptId: "clarify-locked",
      status: "resolved",
      payload: { answers: [redacted, ["eu"]] },
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith("clarify.respond", {
      session_id: "live-private",
      request_id: "clarify-locked",
      question_id: "q1",
      answer: "eu",
    })
    expect(JSON.stringify(request.mock.calls)).not.toContain(
      "[provider path redacted]"
    )
  })

  it("keeps another run's pending interrupt when reconciling the same Session", async () => {
    const request = vi.fn().mockResolvedValue({
      session_id: "live-run-2",
      running: false,
      status: "idle",
    })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-run-1", {
      type: "approval.request",
      session_id: "live-run-1",
      payload: { request_id: "approval-run-1", command: "hold" },
    })

    await interactions.resume({ ...scope, runId: "run-2" })

    expect(interactions.pending(scope)).toHaveLength(1)
  })

  it("ignores a delayed native event that conflicts with an established run binding", async () => {
    const request = vi.fn().mockResolvedValue({ resolved: 1 })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-current", {
      type: "approval.request",
      session_id: "live-current",
      payload: { request_id: "approval-current", command: "hold" },
    })

    expect(
      interactions.acceptNative(scope, "live-foreign", {
        type: "approval.request",
        session_id: "live-foreign",
        payload: { request_id: "approval-foreign", command: "steal" },
      })
    ).toBeUndefined()
    await interactions.respond(scope, {
      interruptId: "approval-current",
      status: "resolved",
      payload: "once",
    })
    expect(request).toHaveBeenCalledWith("approval.respond", {
      session_id: "live-current",
      request_id: "approval-current",
      choice: "once",
    })
  })

  it("treats an oversized native response as uncertain and never replays it", async () => {
    const request = vi.fn().mockResolvedValue({
      status: "ok",
      remaining: Array.from({ length: 20_000 }, (_, index) => `q-${index}`),
    })
    const interactions = new HermesInteractions({ request })
    interactions.acceptNative(scope, "live-private", {
      type: "clarify.request",
      session_id: "live-private",
      payload: { request_id: "clarify-1", question: "Region?" },
    })
    const response = {
      interruptId: "clarify-1",
      status: "resolved",
      payload: { answers: [["eu"]] },
    }

    await expect(interactions.respond(scope, response)).resolves.toEqual({
      status: "uncertain",
    })
    await expect(interactions.respond(scope, response)).resolves.toEqual({
      status: "uncertain",
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("rejects duplicate native batch question ids and locked multi-select values", async () => {
    const duplicateQuestions = new HermesInteractions({ request: vi.fn() })
    expect(() =>
      duplicateQuestions.acceptNative(scope, "live-private", {
        type: "clarify.request",
        session_id: "live-private",
        payload: {
          request_id: "clarify-duplicate",
          questions: [
            {
              qid: "q0",
              question: "First?",
              choices: null,
              multi_select: false,
            },
            {
              qid: "q0",
              question: "Second?",
              choices: null,
              multi_select: false,
            },
          ],
        },
      })
    ).toThrowError("Hermes returned invalid interaction data")

    const duplicateAnswers = new HermesInteractions({
      request: vi.fn().mockResolvedValue({
        session_id: "live-private",
        running: true,
        pending_clarify: {
          request_id: "clarify-duplicate-answer",
          questions: [
            {
              qid: "q0",
              question: "Checks?",
              choices: ["smoke", "e2e"],
              multi_select: true,
            },
          ],
          answers: { q0: '["smoke","smoke"]' },
        },
      }),
    })
    await expect(duplicateAnswers.resume(scope)).rejects.toMatchObject({
      code: "AOS_PROVIDER_INVALID_RESPONSE",
    })
  })

  it("rejects a stale concurrent resume generation before it can replace the authoritative binding", async () => {
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    const request = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve))
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve))
      )
    const interactions = new HermesInteractions({ request })
    const first = interactions.resume(scope)
    const second = interactions.resume(scope)
    resolveSecond({ session_id: "live-new", running: false, status: "idle" })
    await expect(second).resolves.toMatchObject({ status: "idle" })
    resolveFirst({ session_id: "live-stale", running: false, status: "idle" })

    await expect(first).rejects.toMatchObject({
      code: "AOS_RECONCILIATION_STALE",
    })
    expect(
      interactions.acceptNative(scope, "live-stale", {
        type: "approval.request",
        session_id: "live-stale",
        payload: { request_id: "stale", command: "stale" },
      })
    ).toBeUndefined()
  })
})
