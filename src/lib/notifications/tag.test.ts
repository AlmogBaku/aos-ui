import { describe, expect, it } from "vitest"

import { sessionTag } from "./tag"

describe("OS notification tags", () => {
  it("shows a hash of the Session's ids, never the ids", () => {
    expect(sessionTag("agent-1", "thread-1")).toMatch(/^aos-ui-[0-9a-f]+$/)
  })

  it.each([
    ["agent-2", "thread-1"],
    ["agent-1", "thread-2"],
    // The ids stay apart, so no two Sessions can join into one tag.
    ["agent-1thread", "-1"],
  ])("changes for %s/%s", (agentId, sessionId) => {
    expect(sessionTag(agentId, sessionId)).not.toBe(
      sessionTag("agent-1", "thread-1")
    )
  })
})
