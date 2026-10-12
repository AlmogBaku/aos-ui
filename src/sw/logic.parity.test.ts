import { describe, expect, it } from "vitest"

import {
  PUSH_TEXT_LIMITS,
  PushMessageSchema,
  type PushMessage,
} from "@harness-gw/sdk/protocol"

import { readMessage } from "./logic"

/**
 * `readMessage` hand-mirrors `PushMessageSchema` so no zod reaches the service
 * worker bundle. Only this test imports the schema, and it exists to prove the
 * two stay in step on every field the schema knows: a clause added to the
 * schema without a clause added to the worker shows up here as a row that
 * disagrees.
 */

const occurredAt = "2026-09-20T10:11:12.000Z"

function singlePush(overrides: Partial<PushMessage> = {}) {
  return {
    v: 2,
    category: "input",
    agentId: "agent-1",
    sessionId: "session-1",
    occurredAt,
    locale: "en",
    ...overrides,
  }
}

const labelled = singlePush({
  agentName: "a".repeat(PUSH_TEXT_LIMITS.agentName),
  sessionTitle: "s".repeat(PUSH_TEXT_LIMITS.sessionTitle),
  requestText: "r".repeat(PUSH_TEXT_LIMITS.requestText),
  requestMore: 2,
})

/** Every payload both readers must reach the same verdict on. */
const agreed: [name: string, payload: unknown][] = [
  ["a Session with no labels", singlePush()],
  ["every label at its longest", labelled],
  ["the previous version", singlePush({ v: 1 as 2 })],
  ["an unknown category", singlePush({ category: "attention" as never })],
  ["an unknown locale", singlePush({ locale: "ar" as never })],
  ["no Agent id", { ...singlePush(), agentId: undefined }],
  ["no Session id", { ...singlePush(), sessionId: undefined }],
  [
    "an id longer than the protocol allows",
    singlePush({ agentId: "a".repeat(257) }),
  ],
  ["an id carrying a NUL", singlePush({ agentId: "agent\u0000one" })],
]

/**
 * Where the worker deliberately differs: it ignores keys it does not know, so
 * a newer gateway still notifies, and it drops a malformed label instead of
 * the Session's notification.
 */
const relaxed: [name: string, payload: unknown, read: PushMessage][] = [
  [
    "an unknown key",
    { ...singlePush(), image: "https://tracker.example/pixel.png" },
    singlePush() as PushMessage,
  ],
  [
    "a label longer than the protocol allows",
    {
      ...singlePush(),
      agentName: "a".repeat(PUSH_TEXT_LIMITS.agentName + 1),
    },
    singlePush() as PushMessage,
  ],
  [
    "an empty label and a count below one",
    { ...singlePush(), sessionTitle: "", requestMore: 0 },
    singlePush() as PushMessage,
  ],
  // A readable date is all a timestamp needs.
  [
    "a date the schema calls non-ISO",
    singlePush({ occurredAt: "2026-09-20" }),
    singlePush({ occurredAt: "2026-09-20" }) as PushMessage,
  ],
]

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

  it.each(relaxed)(
    "accepts %s, which the schema rejects",
    (_name, payload, read) => {
      expect(PushMessageSchema.safeParse(payload).success).toBe(false)
      expect(readMessage(payload)).toEqual(read)
    }
  )
})
