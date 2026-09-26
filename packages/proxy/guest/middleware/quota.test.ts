import { describe, expect, it, vi } from "vitest"

import { EventSource } from "../../acp/test-harness"
import { providerSessionId, sessionId } from "../../core/ids"
import { runCommand } from "../../core/member"
import { ServerTurnCapacityError, type SessionScope } from "../../core/runtime"
import { SessionCoordinator } from "../../core/session-coordinator"
import { createQuotaMiddleware } from "./quota"

/** Every guest together may hold this many turns, as a deployment defaults. */
const LIMIT = 32

function coordinator() {
  return new SessionCoordinator({
    engine: {
      start: vi.fn(async () => new EventSource()),
      recover: vi.fn(async () => new EventSource()),
    },
    // No test here subscribes anything to a reading.
    readings: { context: vi.fn(), models: vi.fn(), createSession: vi.fn() },
    maxActiveExecutions: 64,
    maxSubscriberEvents: 8,
    maxSubscriberBytes: 64 * 1024,
  })
}

function scopeOf(index: number): SessionScope {
  return {
    agentId: "researcher",
    providerSessionId: providerSessionId(`stored-${index}`),
    sessionId: sessionId(`session-${index}`),
  }
}

/** One send down the quota layer, ending at a turn start in its own Session. */
function send(
  sessions: SessionCoordinator,
  principalId: string,
  index: number
) {
  const scope = scopeOf(index)
  return runCommand(
    [createQuotaMiddleware({ limit: LIMIT })],
    "send",
    { sessionId: scope.sessionId, scope, content: [], text: "Hello" },
    async ({ quota }) => {
      await sessions.start(
        scope,
        {
          turnId: `turn-${index}`,
          messageId: `message-${index}`,
          prompt: "Hello",
        },
        { membershipId: principalId, principalId },
        { quota }
      )
      return { messageId: `message-${index}` }
    }
  )
}

describe("guest quota middleware", () => {
  it("admits one of the concurrent guest sends that reach the last free turn", async () => {
    const sessions = coordinator()
    for (let index = 1; index < LIMIT; index += 1)
      await send(sessions, "guest:token-1", index)

    const results = await Promise.allSettled(
      [LIMIT, LIMIT + 1, LIMIT + 2, LIMIT + 3].map((index) =>
        send(sessions, `guest:token-${index}`, index)
      )
    )

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1
    )
    for (const result of results.filter(({ status }) => status === "rejected"))
      expect(result).toMatchObject({
        reason: expect.any(ServerTurnCapacityError),
      })
  })
})
