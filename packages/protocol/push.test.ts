import { describe, expect, it } from "vitest"

import { categoryOf, PushMessageSchema, PushRegistrationSchema } from "./push"

const base = {
  v: 1,
  occurredAt: "2026-09-20T10:00:00.000Z",
  locale: "en",
} as const

describe("push contract", () => {
  it("maps lifecycle events to the three categories and ignores the rest", () => {
    expect(categoryOf("attention-requested")).toBe("input")
    expect(categoryOf("run-failed")).toBe("failure")
    expect(categoryOf("agent-activation-failed")).toBe("failure")
    expect(categoryOf("run-finished")).toBe("completion")
    expect(categoryOf("agent-ready")).toBe("completion")
    expect(categoryOf("run-started")).toBeUndefined()
    expect(categoryOf("attention-resolved")).toBeUndefined()
  })

  it("ties the Session ids to a count of exactly one", () => {
    const single = {
      ...base,
      category: "input",
      count: 1,
      agentId: "agent",
      sessionId: "session",
    }
    expect(PushMessageSchema.safeParse(single).success).toBe(true)
    expect(
      PushMessageSchema.safeParse({ ...base, category: "failure", count: 3 })
        .success
    ).toBe(true)
    expect(
      PushMessageSchema.safeParse({ ...base, category: "input", count: 1 })
        .success
    ).toBe(false)
    expect(PushMessageSchema.safeParse({ ...single, count: 2 }).success).toBe(
      false
    )
    expect(
      PushMessageSchema.safeParse({ ...single, title: "leak" }).success
    ).toBe(false)
  })

  it("accepts a browser subscription with device preferences", () => {
    const registration = {
      subscription: {
        endpoint: "https://push.example/abc",
        keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
      },
      locale: "he",
      categories: { input: true, failure: true, completion: false },
    }
    expect(PushRegistrationSchema.safeParse(registration).success).toBe(true)
    expect(
      PushRegistrationSchema.safeParse({ ...registration, locale: "fr" })
        .success
    ).toBe(false)
  })
})
