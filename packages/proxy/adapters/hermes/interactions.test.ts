import { describe, expect, it, vi } from "vitest"

import { HermesInteractions, type HermesInteractionScope } from "./interactions"
import { serverRequests } from "./test-utils/server-requests"

const scope: HermesInteractionScope = {
  agentId: "research",
  sessionId: "session-1",
  threadId: "session-1",
}

const LIVE = "live-private"

/**
 * One answering surface over the vendored request channel. `bind` stands in for
 * a completed `session.resume`: the registry knows which durable Session a live
 * Hermes Session id belongs to only once it has resumed it.
 */
function harness(
  options: {
    live?: string
    running?: boolean
    /** Result whose `open_requests` a resume re-delivers before it resolves. */
    resumeResult?: unknown
    log?: { warn: (event: string, fields: Record<string, unknown>) => void }
  } = {}
) {
  const requests = serverRequests()
  const bound = new Map<string, HermesInteractionScope>()
  const live = options.live ?? LIVE
  const ensure = vi.fn(async (target: HermesInteractionScope) => {
    if (options.resumeResult !== undefined)
      requests.deliverOpen(options.resumeResult)
    bound.set(live, { ...target })
    return { liveSessionId: live, running: options.running ?? false }
  })
  const release = vi.fn()
  const retain = vi.fn(async () => release)
  const interactions = new HermesInteractions(
    requests.transport,
    {
      ensure,
      retain,
      scopeFor: (liveSessionId: string) => bound.get(liveSessionId),
    },
    options.log ? { log: options.log } : {}
  )
  return {
    requests,
    interactions,
    ensure,
    retain,
    release,
    bind(liveSessionId = live, target = scope) {
      bound.set(liveSessionId, { ...target })
    },
  }
}

describe("HermesInteractions server requests", () => {
  it("presents a single clarify request as the existing question interrupt", () => {
    const { requests, interactions, bind } = harness()
    bind()

    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
      choices: ["eu", "us"],
    })

    const [outcome] = interactions.pending(scope)
    expect(outcome).toEqual({
      type: "interrupt",
      interrupts: [
        {
          id,
          reason: "question",
          message: "Which region?",
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
                ],
                minItems: 1,
                maxItems: 1,
              },
            },
            required: ["answers"],
            additionalProperties: false,
          },
          metadata: {
            "aos.kind": "questions",
            "aos.scope": "run",
            "aos.questionCount": 1,
          },
        },
      ],
    })
    expect(JSON.stringify(outcome)).not.toContain(LIVE)
    expect(requests.frames()).toEqual([])
  })

  it("answers a single clarify once, on the request Hermes is waiting on", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
      choices: ["eu", "us"],
    })

    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["eu"]] },
      })
    ).resolves.toEqual({ status: "resolved" })

    expect(requests.answer(id)).toEqual({ answer: "eu" })
    expect(requests.frames()).toHaveLength(1)
    expect(interactions.pending(scope)).toEqual([])
  })

  it("answers a single multi-select clarify with every selected value", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which checks?",
      choices: ["smoke", "e2e", "unit"],
      multi_select: true,
    })

    // The interrupt offers the whole selection, so the answer must carry it:
    // Hermes parses a single multi-select answer as a JSON array
    // (`tools/clarify_tool.py` `_parse_multi_select_response`).
    expect(interactions.pending(scope)[0]?.interrupts[0]).toMatchObject({
      responseSchema: {
        properties: {
          answers: {
            prefixItems: [{ maxItems: 3, uniqueItems: true }],
          },
        },
      },
    })

    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["smoke", "e2e"]] },
      })
    ).resolves.toEqual({ status: "resolved" })

    expect(requests.answer(id)).toEqual({ answer: '["smoke","e2e"]' })
    expect(requests.frames()).toHaveLength(1)
  })

  it("presents a clarify batch as one interrupt and answers every question id", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      questions: [
        {
          qid: "q0",
          question: "Which region?",
          choices: ["eu", "us"],
          multi_select: false,
        },
        {
          qid: "q1",
          question: "Which checks?",
          choices: ["smoke", "e2e"],
          multi_select: true,
        },
      ],
    })

    const [outcome] = interactions.pending(scope)
    expect(outcome?.interrupts).toHaveLength(1)
    expect(outcome?.interrupts[0]).toMatchObject({
      id,
      reason: "question",
      message: "2 questions require answers",
      metadata: { "aos.questionCount": 2 },
    })
    expect(JSON.stringify(outcome)).not.toContain("q0")

    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["eu"], ["smoke", "e2e"]] },
      })
    ).resolves.toEqual({ status: "resolved" })

    expect(requests.answer(id)).toEqual({
      answers: { q0: "eu", q1: '["smoke","e2e"]' },
    })
    expect(requests.frames()).toHaveLength(1)
  })

  it("restores answers Hermes already locked as ordered schema defaults", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver(
      "clarify",
      {
        session_id: LIVE,
        questions: [
          {
            qid: "q0",
            question: "Existing path?",
            choices: null,
            multi_select: false,
          },
          {
            qid: "q1",
            question: "Which region?",
            choices: ["eu", "us"],
            multi_select: false,
          },
        ],
        answers: { q0: "/home/operator/secret" },
      },
      { replayed: false }
    )

    const interrupt = interactions.pending(scope)[0]?.interrupts[0]
    expect(interrupt?.metadata).toMatchObject({
      "aos.lockedAnswerIndexes": [0],
    })
    const schema = interrupt?.responseSchema as {
      properties: { answers: { prefixItems: Array<{ default?: string[] }> } }
    }
    const locked = schema.properties.answers.prefixItems[0]!.default!
    expect(locked).toEqual(["[provider path redacted]"])

    // A locked free-text answer is echoed back as its native value: the public
    // redaction must never become the answer Hermes stores.
    await interactions.respond(scope, {
      interruptId: id,
      status: "resolved",
      payload: { answers: [locked, ["eu"]] },
    })

    expect(requests.answer(id)).toEqual({
      answers: { q0: "/home/operator/secret", q1: "eu" },
    })
  })

  it("uses Hermes' own cancellation semantics for a single question and a batch", async () => {
    const single = harness()
    single.bind()
    const singleId = single.requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
    })
    await expect(
      single.interactions.respond(scope, {
        interruptId: singleId,
        status: "cancelled",
      })
    ).resolves.toEqual({ status: "resolved" })
    expect(single.requests.answer(singleId)).toEqual({ answer: "" })

    const batch = harness()
    batch.bind()
    const batchId = batch.requests.deliver("clarify", {
      session_id: LIVE,
      questions: [
        { qid: "q0", question: "Which region?", multi_select: false },
        { qid: "q1", question: "Which checks?", multi_select: false },
      ],
    })
    await batch.interactions.respond(scope, {
      interruptId: batchId,
      status: "cancelled",
    })
    expect(batch.requests.answer(batchId)).toEqual({})
  })

  it("presents an approval with its native choice scopes and answers the choice", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("approval", {
      session_id: LIVE,
      request_id: "approval-1",
      command: "deploy production",
      choices: ["once", "deny", "always"],
      allow_permanent: false,
    })

    expect(interactions.pending(scope)[0]).toEqual({
      type: "interrupt",
      interrupts: [
        {
          id,
          reason: "approval",
          message: "deploy production",
          responseSchema: { type: "string", enum: ["once", "deny"] },
          metadata: {
            "aos.kind": "approval",
            "aos.scope": "run",
            "aos.choiceScopes": { once: "request", deny: "request" },
          },
        },
      ],
    })

    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: "once",
      })
    ).resolves.toEqual({ status: "resolved" })
    expect(requests.answer(id)).toEqual({ choice: "once" })
  })

  it("answers a session or permanent approval choice with the all flag", async () => {
    for (const choice of ["session", "always"] as const) {
      const { requests, interactions, bind } = harness()
      bind()
      const id = requests.deliver("approval", {
        session_id: LIVE,
        request_id: `approval-${choice}`,
        description: "Write to the repository",
      })

      expect(
        interactions.pending(scope)[0]?.interrupts[0]?.metadata?.[
          "aos.choiceScopes"
        ]
      ).toEqual({
        once: "request",
        session: "session",
        always: "agent",
        deny: "request",
      })

      await interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: choice,
      })
      expect(requests.answer(id)).toEqual({ choice, all: true })
    }
  })

  it("denies a cancelled approval", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("approval", {
      session_id: LIVE,
      request_id: "approval-1",
      command: "rm -rf /",
    })

    await interactions.respond(scope, { interruptId: id, status: "cancelled" })

    expect(requests.answer(id)).toEqual({ choice: "deny" })
  })

  it("holds a server request AOS cannot answer instead of cancelling it", () => {
    const { requests, interactions, bind } = harness()
    bind()

    const id = requests.deliver("sudo", {
      session_id: LIVE,
      command: "sudo apt install",
    })

    // Hermes raised this prompt on a Session AOS may share with its own
    // renderer, and `-32601` would cancel it there: AOS claims the request,
    // answers nothing, and presents nothing.
    expect(requests.refusal(id)).toBeUndefined()
    expect(requests.frames()).toEqual([])
    expect(interactions.pending(scope)).toEqual([])
  })

  it("writes nothing when a resume re-delivers an unsupported open request", () => {
    const { requests, interactions, bind } = harness({
      resumeResult: {
        open_requests: [
          {
            id: "srq-00000000000f",
            method: "vault.code",
            params: { session_id: LIVE },
          },
        ],
      },
    })
    bind()

    // Every reconnect re-delivers what is still open, so answering once would
    // cancel the same prompt on every heal or reload.
    return expect(interactions.resume(scope))
      .resolves.toMatchObject({ status: "idle" })
      .then(() => {
        expect(requests.frames()).toEqual([])
        expect(interactions.pending(scope)).toEqual([])
      })
  })

  it("declines a request addressed to a live Session AOS has not bound", () => {
    const { requests, interactions } = harness()

    const id = requests.deliver("clarify", {
      session_id: "live-unknown",
      question: "Which region?",
    })

    expect(requests.refusal(id)).toMatchObject({ code: -32601 })
    expect(interactions.pending(scope)).toEqual([])
  })

  it("claims a recognized request AOS has no room for", () => {
    const { requests, interactions, bind } = harness()
    bind()
    for (let index = 0; index < 64; index += 1)
      requests.deliver("clarify", {
        session_id: LIVE,
        question: `Which region ${index}?`,
      })
    expect(interactions.pending(scope)).toHaveLength(64)

    const overflowing = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region now?",
    })

    // A full AOS may not answer for the user: `-32601` would cancel this prompt
    // for every renderer of a shared Session.
    expect(requests.refusal(overflowing)).toBeUndefined()
    expect(requests.frames()).toEqual([])
    expect(interactions.pending(scope)).toHaveLength(64)
  })

  it("logs a declined and a claimed request of the same method apart", () => {
    const warn = vi.fn()
    const { requests, bind } = harness({ log: { warn } })

    requests.deliver("clarify", {
      session_id: "live-unknown",
      question: "Which region?",
    })
    bind()
    for (let index = 0; index < 65; index += 1)
      requests.deliver("clarify", {
        session_id: LIVE,
        question: `Which region ${index}?`,
      })

    expect(warn.mock.calls).toEqual([
      ["hermes.interactions.request_declined", { method: "clarify" }],
      ["hermes.interactions.request_unanswered", { method: "clarify" }],
    ])
  })

  it("declines a malformed or oversized recognized request payload", () => {
    const { requests, interactions, bind } = harness()
    bind()

    const malformed = requests.deliver("clarify", {
      session_id: LIVE,
      questions: [{ qid: "q0", question: { path: "/etc/shadow" } }],
    })
    const oversized = requests.deliver("approval", {
      session_id: LIVE,
      request_id: "approval-huge",
      command: "x".repeat(70_000),
    })
    const duplicated = requests.deliver("clarify", {
      session_id: LIVE,
      questions: [
        { qid: "q0", question: "One?", multi_select: false },
        { qid: "q0", question: "Two?", multi_select: false },
      ],
    })

    for (const id of [malformed, oversized, duplicated])
      expect(requests.refusal(id)).toMatchObject({ code: -32601 })
    expect(interactions.pending(scope)).toEqual([])
  })

  it("expires a request Hermes cancelled and reports it to a later response", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
    })

    requests.emit({
      type: "request.cancel",
      session_id: LIVE,
      seq: 7,
      payload: { id, method: "clarify", reason: "timeout" },
    })

    expect(interactions.pending(scope)).toEqual([])
    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["eu"]] },
      })
    ).resolves.toEqual({ status: "expired" })
    expect(requests.frames()).toEqual([])
  })

  it("ignores a cancellation addressed to another live Session", () => {
    const { requests, interactions, bind } = harness()
    bind()
    bind("live-other", { ...scope, sessionId: "session-2" })
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
    })

    requests.emit({
      type: "request.cancel",
      session_id: "live-other",
      payload: { id, method: "clarify", reason: "timeout" },
    })

    expect(interactions.pending(scope)).toHaveLength(1)
  })

  it("rebuilds a pending interaction from a resume re-delivery without answering it", async () => {
    const resumeResult = {
      session_id: LIVE,
      running: true,
      open_requests: [
        {
          id: "srq-00000000000a",
          method: "approval",
          params: {
            session_id: LIVE,
            request_id: "approval-restored",
            command: "restart deployment",
          },
        },
      ],
    }
    const { requests, interactions } = harness({
      running: true,
      resumeResult,
    })
    const notified = vi.fn()
    interactions.onInterrupt(scope, notified)

    const snapshot = await interactions.resume(scope)

    expect(snapshot).toMatchObject({
      running: true,
      status: "waiting-for-input",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "srq-00000000000a", reason: "approval" }],
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain(LIVE)
    expect(notified).not.toHaveBeenCalled()
    expect(requests.frames()).toEqual([])

    // A second re-delivery replaces the handle without a duplicate interrupt.
    await interactions.resume(scope)
    expect(interactions.pending(scope)).toHaveLength(1)
    expect(notified).not.toHaveBeenCalled()

    await interactions.respond(scope, {
      interruptId: "srq-00000000000a",
      status: "resolved",
      payload: "once",
    })
    expect(requests.answer("srq-00000000000a")).toEqual({ choice: "once" })
  })

  it("notifies the run when a heal re-delivers a request it has not seen", () => {
    const { requests, interactions, bind } = harness()
    bind()
    const notified = vi.fn()
    interactions.onInterrupt(scope, notified)

    // A `clarify` frame written while the socket was detached reaches AOS only
    // as an `open_requests` re-delivery of the heal that rebound the Session.
    const redelivered = {
      open_requests: [
        {
          id: "srq-00000000000f",
          method: "clarify",
          params: { session_id: LIVE, question: "Which region?" },
        },
      ],
    }
    requests.deliverOpen(redelivered)

    expect(interactions.pending(scope)).toHaveLength(1)
    expect(notified).toHaveBeenCalledTimes(1)
    expect(notified).toHaveBeenCalledWith(interactions.pending(scope)[0])

    // A later re-delivery of the same request only replaces its handle.
    requests.deliverOpen(redelivered)
    expect(interactions.pending(scope)).toHaveLength(1)
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it("notifies an active run once per live interrupt until it unsubscribes", () => {
    const { requests, interactions, bind } = harness()
    bind()
    const notified = vi.fn()
    const stop = interactions.onInterrupt(scope, notified)

    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
    })

    expect(notified).toHaveBeenCalledTimes(1)
    expect(notified.mock.calls[0]?.[0]).toMatchObject({
      type: "interrupt",
      interrupts: [{ id, reason: "question" }],
    })

    stop()
    requests.deliver("clarify", { session_id: LIVE, question: "Another?" })
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it("notifies only the run bound to the addressed Session", () => {
    const { requests, interactions, bind } = harness()
    const other = { ...scope, sessionId: "session-2", threadId: "session-2" }
    bind()
    bind("live-other", other)
    const notified = vi.fn()
    const otherNotified = vi.fn()
    interactions.onInterrupt(scope, notified)
    interactions.onInterrupt(other, otherNotified)

    requests.deliver("clarify", { session_id: "live-other", question: "?" })

    expect(notified).not.toHaveBeenCalled()
    expect(otherNotified).toHaveBeenCalledTimes(1)
    expect(interactions.pending(scope)).toEqual([])
    expect(interactions.pending(other)).toHaveLength(1)
  })

  it("keeps a pending interaction when the connection cannot carry its answer", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
    })
    requests.disconnect()

    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["eu"]] },
      })
    ).resolves.toEqual({ status: "uncertain" })

    expect(interactions.pending(scope)).toHaveLength(1)
    expect(requests.frames()).toEqual([])

    requests.reconnect()
    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["eu"]] },
      })
    ).resolves.toEqual({ status: "resolved" })
    expect(requests.answer(id)).toEqual({ answer: "eu" })
  })

  it("makes a repeated identical response idempotent and rejects a changed one", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("approval", {
      session_id: LIVE,
      request_id: "approval-1",
      command: "deploy",
    })
    const response = {
      interruptId: id,
      status: "resolved" as const,
      payload: "once",
    }

    await expect(interactions.respond(scope, response)).resolves.toEqual({
      status: "resolved",
    })
    await expect(interactions.respond(scope, response)).resolves.toEqual({
      status: "already-resolved",
    })
    await expect(
      interactions.respond(scope, { ...response, payload: "deny" })
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    expect(requests.frames()).toHaveLength(1)
  })

  it("does not reopen a completed interaction from a duplicate live request", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("approval", {
      session_id: LIVE,
      request_id: "approval-1",
      command: "deploy",
    })
    await interactions.respond(scope, {
      interruptId: id,
      status: "resolved",
      payload: "once",
    })

    requests.deliver(
      "approval",
      { session_id: LIVE, request_id: "approval-1", command: "deploy" },
      { id }
    )

    expect(interactions.pending(scope)).toEqual([])
    expect(requests.frames()).toHaveLength(1)
  })

  it("rejects cross-Agent and cross-Session interaction substitution", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("approval", {
      session_id: LIVE,
      request_id: "approval-1",
      command: "deploy",
    })

    // A Hermes Session carries exactly one thread, so Agent and Session are the
    // two dimensions an answer may not cross.
    for (const foreign of [
      { ...scope, agentId: "other" },
      { ...scope, sessionId: "session-2" },
    ])
      await expect(
        interactions.respond(foreign, {
          interruptId: id,
          status: "resolved",
          payload: "once",
        })
      ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
    expect(requests.frames()).toEqual([])
  })

  it("rejects a malformed answer without answering Hermes", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
      choices: ["eu", "us"],
    })

    for (const payload of [
      { answers: [["ap"]] },
      { answers: [] },
      { answers: [["eu"], ["us"]] },
      { answers: [["eu", "us"]] },
      "eu",
    ])
      await expect(
        interactions.respond(scope, {
          interruptId: id,
          status: "resolved",
          payload,
        })
      ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["eu"]] },
        extra: true,
      })
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    expect(requests.frames()).toEqual([])
  })

  it("preserves exact native choices and free-text answer whitespace", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      questions: [
        {
          qid: "q0",
          question: "Which region?",
          choices: ["  eu-west  ", "us"],
          multi_select: false,
        },
        { qid: "q1", question: "Notes?", choices: null, multi_select: false },
      ],
    })

    await interactions.respond(scope, {
      interruptId: id,
      status: "resolved",
      payload: { answers: [["  eu-west  "], ["  keep  spacing  "]] },
    })

    expect(requests.answer(id)).toEqual({
      answers: { q0: "  eu-west  ", q1: "  keep  spacing  " },
    })
  })

  it("redacts native credentials, URLs, and paths while answering exactly", async () => {
    const { requests, interactions, bind } = harness()
    bind()
    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Use https://hermes.internal with token=secret?",
      choices: ["/home/operator/run.sh", "skip"],
    })

    const interrupt = interactions.pending(scope)[0]?.interrupts[0]
    expect(interrupt?.message).toBe(
      "Use [provider location redacted] with [credential redacted]"
    )
    const choices = (
      interrupt?.responseSchema as {
        properties: {
          answers: {
            prefixItems: Array<{ items: { enum?: string[] } }>
          }
        }
      }
    ).properties.answers.prefixItems[0]!.items.enum!
    expect(choices[0]).toBe("[provider path redacted]")

    await interactions.respond(scope, {
      interruptId: id,
      status: "resolved",
      payload: { answers: [[choices[0]!]] },
    })

    expect(requests.answer(id)).toEqual({ answer: "/home/operator/run.sh" })
  })

  it("enforces question count, nesting, and answer byte limits", async () => {
    const { requests, interactions, bind } = harness()
    bind()

    const tooMany = requests.deliver("clarify", {
      session_id: LIVE,
      questions: Array.from({ length: 33 }, (_, index) => ({
        qid: `q${index}`,
        question: `Question ${index}?`,
        multi_select: false,
      })),
    })
    expect(requests.refusal(tooMany)).toMatchObject({ code: -32601 })

    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Notes?",
    })
    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["x".repeat(4_097)]] },
      })
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: { answers: [["x".repeat(70_000)]] },
      })
    ).rejects.toMatchObject({ code: "AOS_LIMIT_EXCEEDED" })
    expect(requests.answer(id)).toBeUndefined()
  })

  it("expires a pending interaction Hermes rebound to another live Session", async () => {
    const { requests, interactions, bind } = harness({ live: "live-run-2" })
    bind("live-run-1")
    const id = requests.deliver("approval", {
      session_id: "live-run-1",
      request_id: "approval-run-1",
      command: "hold",
    })
    expect(interactions.pending(scope)).toHaveLength(1)

    await expect(interactions.resume(scope)).resolves.toEqual({
      running: false,
      status: "idle",
    })

    expect(interactions.pending(scope)).toEqual([])
    await expect(
      interactions.respond(scope, {
        interruptId: id,
        status: "resolved",
        payload: "once",
      })
    ).resolves.toEqual({ status: "expired" })
  })

  it("projects a resume outage as a safe typed error", async () => {
    const requests = serverRequests()
    const interactions = new HermesInteractions(requests.transport, {
      ensure: async () => {
        throw new Error("token=secret https://hermes.internal /home/operator")
      },
      scopeFor: () => undefined,
    })

    await expect(interactions.resume(scope)).rejects.toMatchObject({
      code: "AOS_PROVIDER_UNAVAILABLE",
      message: "Hermes is temporarily unavailable",
    })
  })

  it("resumes through the registry's single native binding", async () => {
    const { interactions, ensure } = harness({ running: true })

    await expect(
      Promise.all([interactions.resume(scope), interactions.resume(scope)])
    ).resolves.toEqual([
      { running: true, status: "running" },
      { running: true, status: "running" },
    ])
    expect(ensure).toHaveBeenCalledTimes(2)
    // Reconciliation is authoritative: Hermes is asked again, through the one
    // registry binding, rather than read from a cached one.
    expect(ensure).toHaveBeenLastCalledWith(scope, { refresh: true })
  })

  it("logs a bounded, truncated set of unanswerable server-request methods", () => {
    const warn = vi.fn()
    const { requests, bind } = harness({ log: { warn } })
    bind()

    const long = `sudo.${"x".repeat(200)}`
    requests.deliver(long, { session_id: LIVE })
    expect(warn).toHaveBeenCalledWith(
      "hermes.interactions.request_unanswered",
      { method: long.slice(0, 64) }
    )
    // Hermes owns the method text and the volume: one line per distinct method,
    // truncated, and the remembered set is capped.
    requests.deliver(long, { session_id: LIVE })
    expect(warn).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 64; index += 1)
      requests.deliver(`vault.code.${index}`, { session_id: LIVE })
    expect(warn).toHaveBeenCalledTimes(32)
  })

  it("releases both subscriptions on close", () => {
    const { requests, interactions, bind } = harness()
    bind()
    interactions.close()

    const id = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
    })

    expect(requests.refusal(id)).toMatchObject({ code: -32601 })
    expect(interactions.pending(scope)).toEqual([])
  })

  it("retains the attachment while a request waits and releases it after", async () => {
    const { requests, interactions, retain, release, bind } = harness()
    bind()
    const first = requests.deliver("clarify", {
      session_id: LIVE,
      question: "Which region?",
    })
    const second = requests.deliver("approval", {
      session_id: LIVE,
      request_id: "approval-1",
      command: "deploy",
    })

    expect(retain).toHaveBeenCalledExactlyOnceWith(scope, "interaction")

    await interactions.respond(scope, {
      interruptId: first,
      status: "resolved",
      payload: { answers: [["eu"]] },
    })
    // One request is still waiting on this Session.
    expect(release).not.toHaveBeenCalled()

    await interactions.respond(scope, {
      interruptId: second,
      status: "resolved",
      payload: "once",
    })
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  })

  it("reports operation-specific interaction capabilities with choices, scopes, limits, and limitations", () => {
    const { interactions } = harness()

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
        maxStringBytes: 4_096,
      },
      reactions: {
        status: "unavailable",
        reason: "native-reaction-operation-unavailable",
      },
    })
  })
})
