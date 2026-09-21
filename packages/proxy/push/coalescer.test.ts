import { describe, expect, it, vi } from "vitest"

import { COALESCE_WINDOW_MS, type PushCategory } from "../../protocol/push"
import {
  createPushCoalescer,
  type CoalescedSession,
  type PresenceVerdict,
  type PushCoalescerOptions,
} from "./coalescer"
import { createTestTimers } from "./test-utils/timers"

const START = 1_700_000_000_000
const GRACE_MS = 60_000
const OPERATOR = "operator"

type Emitted = {
  principalId: string
  category: PushCategory
  sessions: CoalescedSession[]
  closedAt: number
}

function harness(
  overrides: Partial<
    Pick<PushCoalescerOptions, "filter" | "presence" | "windowMs">
  > = {}
) {
  const clock = createTestTimers(START)
  const emitted: Emitted[] = []
  const coalescer = createPushCoalescer({
    now: clock.now,
    schedule: clock.schedule,
    windowMs: overrides.windowMs ?? COALESCE_WINDOW_MS,
    graceMs: GRACE_MS,
    filter:
      overrides.filter ?? ((_principalId, _category, sessions) => sessions),
    presence: overrides.presence ?? (() => ({ state: "absent" })),
    emit: (principalId, category, sessions, closedAt) => {
      emitted.push({ principalId, category, sessions, closedAt })
    },
  })
  return { clock, coalescer, emitted }
}

const session = (
  sessionId: string,
  occurredAtMs = START
): CoalescedSession => ({
  agentId: "researcher",
  sessionId,
  occurredAtMs,
})

describe("push coalescer", () => {
  it("sends one push for a burst, from the window the first event opened", () => {
    const { clock, coalescer, emitted } = harness()

    coalescer.add(OPERATOR, "input", session("session-1"))
    clock.advance(1_000)
    coalescer.add(OPERATOR, "input", session("session-2"))
    coalescer.add(OPERATOR, "input", session("session-2"))
    clock.advance(1_000)
    expect(emitted).toEqual([])

    clock.advance(1_000)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      principalId: OPERATOR,
      category: "input",
      closedAt: START + COALESCE_WINDOW_MS.input,
    })
    expect(emitted[0]!.sessions).toEqual([
      session("session-1"),
      session("session-2"),
    ])
  })

  it("answers for the earliest event it collapsed for each Session", () => {
    const { clock, coalescer, emitted } = harness()

    coalescer.add(OPERATOR, "input", session("session-1", START + 500))
    coalescer.add(OPERATOR, "input", session("session-1", START + 100))
    coalescer.add(OPERATOR, "input", session("session-1", START + 900))
    clock.advance(COALESCE_WINDOW_MS.input)

    expect(emitted[0]!.sessions).toEqual([session("session-1", START + 100)])
  })

  it("never extends an open window, however late the last event is", () => {
    const { clock, coalescer, emitted } = harness()

    coalescer.add(OPERATOR, "completion", session("session-1"))
    clock.advance(19_000)
    coalescer.add(OPERATOR, "completion", session("session-2"))
    clock.advance(1_000)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.closedAt).toBe(START + COALESCE_WINDOW_MS.completion)
    clock.advance(60_000)
    expect(emitted).toHaveLength(1)
  })

  it("sends nothing when the gate drops every Session", () => {
    const filter = vi.fn(() => [])
    const { clock, coalescer, emitted } = harness({ filter })

    coalescer.add(OPERATOR, "input", session("session-1"))
    clock.advance(COALESCE_WINDOW_MS.input)

    expect(filter).toHaveBeenCalledOnce()
    expect(emitted).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it("drops the window while somebody is watching the workspace", () => {
    const { clock, coalescer, emitted } = harness({
      presence: () => ({ state: "present" }),
    })

    coalescer.add(OPERATOR, "input", session("session-1"))
    clock.advance(COALESCE_WINDOW_MS.input)

    expect(emitted).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it("holds a window until a departing operator's grace has run out", () => {
    let verdict: PresenceVerdict = {
      state: "grace",
      untilMs: START + GRACE_MS,
    }
    const { clock, coalescer, emitted } = harness({ presence: () => verdict })

    coalescer.add(OPERATOR, "input", session("session-1"))
    clock.advance(COALESCE_WINDOW_MS.input)
    expect(emitted).toEqual([])
    expect(clock.pending()).toBe(1)

    // A Session that arrives while the window waits still joins the same push.
    coalescer.add(OPERATOR, "input", session("session-2"))
    verdict = { state: "absent" }
    clock.advance(GRACE_MS)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.sessions).toHaveLength(2)
    expect(emitted[0]!.closedAt).toBe(START + GRACE_MS)
  })

  it("waits out one grace only, then sends to an operator who is still away", () => {
    const { clock, coalescer, emitted } = harness({
      // A grace that keeps moving: without a cap the window would never close.
      presence: () => ({ state: "grace", untilMs: clock.now() + GRACE_MS }),
    })

    coalescer.add(OPERATOR, "input", session("session-1"))
    clock.advance(COALESCE_WINDOW_MS.input)
    expect(emitted).toEqual([])

    clock.advance(GRACE_MS)

    expect(emitted).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  it("sends nothing when the operator is back before the grace ends", () => {
    let verdict: PresenceVerdict = {
      state: "grace",
      untilMs: START + GRACE_MS,
    }
    const { clock, coalescer, emitted } = harness({ presence: () => verdict })

    coalescer.add(OPERATOR, "input", session("session-1"))
    clock.advance(COALESCE_WINDOW_MS.input)
    verdict = { state: "present" }
    clock.advance(GRACE_MS)

    expect(emitted).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it("keeps a window per category and per principal", () => {
    const { clock, coalescer, emitted } = harness()

    coalescer.add(OPERATOR, "input", session("session-1"))
    coalescer.add(OPERATOR, "completion", session("session-1"))
    coalescer.add("operator-2", "input", session("session-9"))
    clock.advance(COALESCE_WINDOW_MS.input)

    expect(emitted).toHaveLength(2)
    expect(emitted.map(({ principalId }) => principalId)).toEqual([
      OPERATOR,
      "operator-2",
    ])
    clock.advance(COALESCE_WINDOW_MS.completion)
    expect(emitted).toHaveLength(3)
    expect(emitted[2]).toMatchObject({
      principalId: OPERATOR,
      category: "completion",
    })
  })

  it("cancels every open window when it closes", () => {
    const { clock, coalescer, emitted } = harness()
    coalescer.add(OPERATOR, "input", session("session-1"))
    coalescer.add(OPERATOR, "completion", session("session-1"))

    coalescer.close()

    expect(clock.pending()).toBe(0)
    coalescer.add(OPERATOR, "input", session("session-2"))
    clock.advance(60_000)
    expect(emitted).toEqual([])
    expect(clock.pending()).toBe(0)
  })
})
