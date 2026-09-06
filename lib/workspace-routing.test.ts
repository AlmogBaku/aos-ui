import { describe, expect, it } from "vitest"

import {
  buildWorkspacePathname,
  parseWorkspacePathname,
  workspaceHref,
} from "@/lib/workspace-routing"

describe("workspace routing", () => {
  it.each([
    ["/", { agentId: null, sessionId: null }],
    ["/agent-aster", { agentId: "agent-aster", sessionId: null }],
    [
      "/agent-aster/session-1",
      { agentId: "agent-aster", sessionId: "session-1" },
    ],
    [
      "/draft%3Asession-1/thread%20one",
      { agentId: "draft:session-1", sessionId: "thread one" },
    ],
  ])("parses %s", (pathname, expected) => {
    expect(parseWorkspacePathname(pathname)).toEqual(expected)
  })

  it.each(["/one/two/three", "/%E0%A4%A"])(
    "rejects invalid path %s",
    (pathname) => {
      expect(parseWorkspacePathname(pathname)).toBeNull()
    }
  )

  it("encodes each route segment", () => {
    expect(
      buildWorkspacePathname({ agentId: "draft:one", sessionId: "thread one" })
    ).toBe("/draft%3Aone/thread%20one")
  })

  it("preserves the current query and hash", () => {
    expect(
      workspaceHref("https://example.test/old?panel=activity#latest", {
        agentId: "agent-aster",
        sessionId: "session-1",
      })
    ).toBe("/agent-aster/session-1?panel=activity#latest")
  })
})
