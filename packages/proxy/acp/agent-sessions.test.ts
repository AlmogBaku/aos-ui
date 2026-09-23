// @vitest-environment node

import { describe, expect, it } from "vitest"

import type { Session } from "../../protocol"
import type { SessionExecutionState } from "../core/session-coordinator"
import { overlaidStatus } from "./agent-sessions"

describe("public Session status", () => {
  it.each([
    ["idle", "idle"],
    ["running", "running"],
    ["stopping", "running"],
    ["waiting-for-input", "waiting-for-input"],
    ["uncertain", "failed"],
  ] satisfies Array<[SessionExecutionState, Session["status"]]>)(
    "reports %s execution as %s",
    (state, expected) => {
      expect(overlaidStatus(state, "idle")).toBe(expected)
    }
  )

  it("keeps the settled status the provider reported while no execution runs", () => {
    // A row a live execution says nothing about keeps the provider's own answer;
    // a history load, which has no row, supplies `idle` as its own authority.
    expect(overlaidStatus("idle", "failed")).toBe("failed")
    expect(overlaidStatus("idle", "waiting-for-input")).toBe(
      "waiting-for-input"
    )
  })

  it("lets a live execution outrank the settled status", () => {
    expect(overlaidStatus("running", "failed")).toBe("running")
    expect(overlaidStatus("waiting-for-input", "idle")).toBe(
      "waiting-for-input"
    )
  })
})
