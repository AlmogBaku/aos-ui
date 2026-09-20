import { describe, expect, it, vi } from "vitest"

import { COALESCE_WINDOW_MS, type PushCategory } from "../../protocol/push"
import {
  createPushCoalescer,
  type CoalescedSession,
  type PresenceVerdict,
  type PushCoalescerOptions,
} from "./coalescer"

const START = 1_700_000_000_000
const GRACE_MS = 60_000
const OPERATOR = "operator"

/** A clock and a timer queue the test steps through by hand. */
function timers() {
  const scheduled = new Map<number, { at: number; callback: () => void }>()
  let handles = 0
  let current = START
  return {
    now: () => current,
    pending: () => scheduled.size,
    schedule(callback: () => void, delayMs: number) {
      const handle = (handles += 1)
      scheduled.set(handle, { at: current + delayMs, callback })
      return () => {
        scheduled.delete(handle)
      }
    },
    /** Fires every callback due within the step, in due order. */
    advance(ms: number) {
      const until = current + ms
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, left], [, right]) => left.at - right.at)[0]
        if (!due) break
        scheduled.delete(due[0])
        current = due[1].at
        due[1].callback()
      }
      current = until
    },
  }
}

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
  const clock = timers()
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

const session = (sessionId: string): CoalescedSession => ({
  agentId: "researcher",
  sessionId,
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
