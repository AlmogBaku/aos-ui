import { describe, expect, it } from "vitest"

import { runEvents, type MemberEvent } from "../../core/member"
import { createScopeMiddleware } from "./scope"

const REF = "invited-ref"

const layer = createScopeMiddleware({
  grant: { agentId: "agent", ref: REF, principalId: "guest", expiresAt: 100 },
  invited: async () => undefined,
  capabilities: async () => {
    throw new Error("The scope layer reads no capabilities here")
  },
})

/** One event about `sessionId` through the guest's scope layer. */
const shown = (sessionId: string) =>
  runEvents([layer], { sessionId, kind: "invalidated" } as MemberEvent, {
    decline: () => undefined,
  })

describe("guest scope layer", () => {
  it("passes an event about the invited conversation", () => {
    expect(shown(REF)).toEqual({ sessionId: REF, kind: "invalidated" })
  })

  it("drops an event about any other Session", () => {
    expect(shown("operator-session")).toBeUndefined()
  })
})
