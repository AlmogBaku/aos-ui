import { describe, expect, it } from "vitest"

import { notificationTag } from "./tag"

describe("OS notification tags", () => {
  it("hashes opaque identity into a stable tag", () => {
    expect(notificationTag("agent-1", "thread-1", "event-1")).toBe(
      "aos-ui-6c9a0078"
    )
  })

  it.each([
    ["agent-2", "thread-1", "event-1"],
    ["agent-1", "thread-2", "event-1"],
    ["agent-1", "thread-1", "event-2"],
  ])("changes for %s/%s/%s", (agentId, threadId, id) => {
    expect(notificationTag(agentId, threadId, id)).not.toBe(
      notificationTag("agent-1", "thread-1", "event-1")
    )
  })
})
