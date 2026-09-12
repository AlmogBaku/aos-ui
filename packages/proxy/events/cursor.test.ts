import { describe, expect, it } from "vitest"

import {
  createReconnectCursorCodec,
  type ReconnectCursorBinding,
} from "./cursor"

const key = Buffer.alloc(32, 7)

function binding(
  overrides: Partial<ReconnectCursorBinding> = {}
): ReconnectCursorBinding {
  return {
    deploymentId: "deployment-a",
    lane: "operator",
    principalId: "operator-42",
    authorizationRevision: "grant-9",
    scope: "workspace-1/session-7",
    agentId: "researcher",
    sessionId: "session-7",
    bootEpoch: "boot-3",
    streamId: "stream-11",
    ...overrides,
  }
}

function codec(now = 1_700_000_000) {
  return createReconnectCursorCodec({
    activeKeyId: "key-1",
    keys: { "key-1": key },
    now: () => now,
  })
}

describe("reconnect cursor codec", () => {
  it("seals claims with a fresh opaque AEAD token and opens only the matching binding", () => {
    const claims = { ...binding(), iat: 1_700_000_000, exp: 1_700_000_060 }
    const cursor = codec().seal(claims)

    expect(cursor).not.toContain("operator-42")
    expect(cursor).not.toContain("workspace-1")
    expect(cursor).not.toContain("session-7")
    expect(cursor).toMatch(
      /^v1\.key-1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u
    )
    expect(codec().open(cursor, binding())).toEqual({
      ...claims,
      version: 1,
      keyId: "key-1",
    })
    expect(codec().seal(claims)).not.toBe(cursor)
  })

  it("returns the same invalid result for malformed, noncanonical, oversized, and tampered tokens", () => {
    const cursor = codec().seal({
      ...binding(),
      iat: 1_700_000_000,
      exp: 1_700_000_060,
    })
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`
    const noncanonical = `${cursor}=`

    for (const candidate of [
      "not-a-cursor",
      noncanonical,
      tampered,
      "a".repeat(4_097),
    ]) {
      expect(codec().open(candidate, binding())).toBeNull()
    }
  })

  it("returns the generic invalid result for a wrong key or any changed authorization binding", () => {
    const claims = { ...binding(), iat: 1_700_000_000, exp: 1_700_000_060 }
    const cursor = codec().seal(claims)
    const wrongKey = createReconnectCursorCodec({
      activeKeyId: "key-2",
      keys: { "key-2": Buffer.alloc(32, 8) },
      now: () => 1_700_000_000,
    })

    expect(wrongKey.open(cursor, binding())).toBeNull()
    for (const changedBinding of [
      binding({ deploymentId: "deployment-b" }),
      binding({
        lane: "guest",
        principalId: undefined,
        invitationId: "invite-1",
      }),
      binding({ principalId: "operator-43" }),
      binding({ authorizationRevision: "grant-10" }),
      binding({ scope: "workspace-1/session-8" }),
      binding({ agentId: "writer" }),
      binding({ sessionId: "session-8" }),
      binding({ bootEpoch: "boot-4" }),
      binding({ streamId: "stream-12" }),
    ]) {
      expect(codec().open(cursor, changedBinding)).toBeNull()
    }
  })

  it("rejects expired cursors and rejects invalid oversized trusted claims before sealing", () => {
    const claims = { ...binding(), iat: 1_700_000_000, exp: 1_700_000_060 }
    const cursor = codec(1_700_000_061).seal(claims)

    expect(codec(1_700_000_060).open(cursor, binding())).toBeNull()
    expect(() =>
      codec().seal({
        ...claims,
        scope: "x".repeat(513),
      })
    ).toThrow("Invalid reconnect cursor")
  })
})
