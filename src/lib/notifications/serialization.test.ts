import { describe, expect, it } from "vitest"

import { deserializeActivity, serializeActivity } from "./serialization"
import { defaultBrowserPreferences } from "./policy"

const snapshot = { version: 2, preferences: defaultBrowserPreferences }
const legacyRecord = {
  id: "finish-1",
  agentId: "agent-1",
  threadId: "thread-1",
  type: "run-finished",
  lifecycleId: "run-1",
  occurredAt: "2026-09-05T12:00:00.000Z",
  read: true,
  resolved: false,
  browserDeliveredAt: null,
}

describe("versioned Activity persistence", () => {
  it("round-trips notification preferences", () => {
    const serialized = serializeActivity({
      ...snapshot,
      preferences: { ...defaultBrowserPreferences, enabled: true },
    })
    expect(deserializeActivity(serialized)).toEqual({
      version: 2,
      preferences: { ...defaultBrowserPreferences, enabled: true },
    })
  })

  it("drops a version 1 snapshot instead of restoring its Activity history", () => {
    expect(
      deserializeActivity(
        JSON.stringify({
          version: 1,
          records: [legacyRecord],
          preferences: defaultBrowserPreferences,
        })
      )
    ).toBeNull()
  })

  it.each([
    "invalid-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...snapshot, records: [] }),
    JSON.stringify({ ...snapshot, version: 3 }),
    JSON.stringify({ ...snapshot, extra: "private-value" }),
    JSON.stringify({
      version: 2,
      preferences: { ...defaultBrowserPreferences, enabled: "yes" },
    }),
    JSON.stringify({
      version: 2,
      preferences: { enabled: true, completion: true, failure: true },
    }),
    JSON.stringify({
      version: 2,
      preferences: { ...defaultBrowserPreferences, tone: "loud" },
    }),
  ])("rejects malformed or unexpected persisted data %#", (serialized) => {
    expect(deserializeActivity(serialized)).toBeNull()
  })

  it("projects preferences onto the privacy allowlist before writing", () => {
    const secrets = {
      message: "private-message",
      prompt: "private-prompt",
      name: "private-agent-name",
      title: "private-thread-title",
    }
    const serialized = serializeActivity({
      ...snapshot,
      records: [{ ...legacyRecord, ...secrets }],
      preferences: { ...defaultBrowserPreferences, ...secrets },
      ...secrets,
    })

    expect(JSON.parse(serialized)).toEqual(snapshot)
    for (const secret of Object.values(secrets))
      expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("thread-1")
  })
})
