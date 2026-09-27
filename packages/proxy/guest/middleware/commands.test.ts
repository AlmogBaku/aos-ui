import { describe, expect, it } from "vitest"

import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"
import { CAPABILITIES } from "../../acp/test-harness"
import { runEvents } from "../../core/member"
import { createCommandsMiddleware } from "./commands"

describe("guest commands", () => {
  it("shows a guest its commands event without the operator's slash commands", () => {
    const shown = runEvents(
      [createCommandsMiddleware()],
      {
        sessionId: "ref",
        kind: "commands",
        capabilities:
          SessionWorkspaceCapabilitiesResponseSchema.parse(CAPABILITIES),
      },
      { decline: () => undefined }
    )

    expect(
      shown?.kind === "commands" && shown.capabilities.workspace.slashCommands
    ).toEqual({
      status: "unavailable",
      reason: "operator-session-controls-required",
    })
  })
})
