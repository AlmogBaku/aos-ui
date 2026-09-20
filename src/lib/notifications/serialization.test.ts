import { describe, expect, it } from "vitest"

import { deserializeActivity, serializeActivity } from "./serialization"
import { defaultBrowserPreferences } from "./policy"

const snapshot = { version: 3, preferences: defaultBrowserPreferences }
const version2 = (enabled: boolean) =>
  JSON.stringify({
    version: 2,
    preferences: { enabled, completion: true, failure: true, input: false },
  })
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
    const preferences = {
      ...defaultBrowserPreferences,
      sound: false,
      prompt: "declined" as const,
    }
    const serialized = serializeActivity({ ...snapshot, preferences })
    expect(deserializeActivity(serialized)).toEqual({ version: 3, preferences })
  })

  it("adopts default-on for a version 2 device that never chose", () => {
    expect(deserializeActivity(version2(false))).toEqual({
      version: 3,
      preferences: {
        enabled: true,
        completion: true,
        failure: true,
        input: false,
        sound: true,
        prompt: "pending",
      },
    })
  })

  it("reads a version 2 opt-in as an already answered ask", () => {
    expect(deserializeActivity(version2(true))).toEqual({
      version: 3,
      preferences: {
        enabled: true,
        completion: true,
        failure: true,
        input: false,
        sound: true,
        prompt: "accepted",
      },
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
    JSON.stringify({ ...snapshot, version: 4 }),
    JSON.stringify({ ...snapshot, extra: "private-value" }),
    JSON.stringify({
      version: 3,
      preferences: { ...defaultBrowserPreferences, enabled: "yes" },
    }),
    JSON.stringify({
      version: 3,
      preferences: { ...defaultBrowserPreferences, prompt: "maybe" },
    }),
    JSON.stringify({
      version: 3,
      preferences: {
        enabled: true,
        completion: true,
        failure: true,
        input: true,
        sound: true,
      },
    }),
    JSON.stringify({
      version: 3,
      preferences: { ...defaultBrowserPreferences, tone: "loud" },
    }),
    // Version 2 never carried the ask state, so it never arrives with one.
    JSON.stringify({ version: 2, preferences: defaultBrowserPreferences }),
    JSON.stringify({
      version: 2,
      preferences: {
        enabled: true,
        completion: true,
        failure: true,
        input: true,
        tone: "loud",
      },
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
      preferences: { ...defaultBrowserPreferences, note: secrets.message },
      ...secrets,
    })

    expect(JSON.parse(serialized)).toEqual(snapshot)
    for (const secret of Object.values(secrets))
      expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("thread-1")
  })

  it("refuses to write content in place of the ask state", () => {
    expect(() =>
      serializeActivity({
        ...snapshot,
        preferences: { ...defaultBrowserPreferences, prompt: "private-prompt" },
      })
    ).toThrow()
  })
})
