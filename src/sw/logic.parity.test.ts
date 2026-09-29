import { describe, expect, it } from "vitest"

import { PushMessageSchema, type PushMessage } from "@aos/protocol/push"

import { readMessage } from "./logic"

/**
 * `readMessage` hand-mirrors `PushMessageSchema` so no zod reaches the service
 * worker bundle. Only this test imports the schema, and it exists to prove the
 * two stay in step: a clause added to the schema without a clause added to the
 * worker shows up here as a row that disagrees.
 */

const occurredAt = "2026-09-20T10:11:12.000Z"

function singlePush(overrides: Partial<PushMessage> = {}) {
  return {
    v: 1,
    category: "input",
    count: 1,
    agentId: "agent-1",
    sessionId: "session-1",
    occurredAt,
    locale: "en",
    ...overrides,
  }
}

const counted = {
  v: 1,
  category: "completion",
  count: 3,
  occurredAt,
  locale: "he",
}

/**
 * Every payload both readers must reach the same verdict on. Keep two accepted
 * rows and one rejection row; logic.test.ts and push.test.ts already cover the
 * rest of the rejection matrix. The two accepted rows prevent a vacuous run.
 */
const agreed: [name: string, payload: unknown][] = [
  ["a single Session", singlePush()],
  ["a count", counted],
  ["a count below one", { ...counted, count: 0 }],
]

/** The one clause the worker deliberately relaxes; see `readMessage`. */
const dateOnly = singlePush({ occurredAt: "2026-09-20" })

describe("hand-parsed push payloads", () => {
  it.each(agreed)("reaches the schema's verdict on %s", (_name, payload) => {
    const parsed = PushMessageSchema.safeParse(payload)
    const read = readMessage(payload)

    expect(read !== undefined).toBe(parsed.success)
    if (parsed.success) expect(read).toEqual(parsed.data)
  })

  it("carries both verdicts, so agreement is never vacuous", () => {
    const verdicts = agreed.map(
      ([, payload]) => PushMessageSchema.safeParse(payload).success
    )

    expect(new Set(verdicts)).toEqual(new Set([true, false]))
  })

  it("diverges only in accepting a readable date the schema calls non-ISO", () => {
    expect(PushMessageSchema.safeParse(dateOnly).success).toBe(false)
    expect(readMessage(dateOnly)).toEqual(dateOnly)
    expect(Number.isNaN(Date.parse(dateOnly.occurredAt))).toBe(false)
  })
})
