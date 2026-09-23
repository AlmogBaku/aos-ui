import { describe, expect, it } from "vitest"
import { SessionWorkspaceCapabilitiesResponseSchema } from "../../../protocol"

import { openCodeCapabilities } from "./capabilities"

describe("openCodeCapabilities", () => {
  it("reports exact native choices and explicit unavailable operations", () => {
    expect(openCodeCapabilities()).toMatchObject({
      interactions: {
        questions: {
          status: "available",
          protocol: "acp-request",
          scope: "run",
        },
        approvals: {
          status: "available",
        },
      },
      content: {
        artifacts: {
          status: "available",
          scope: "session",
          maxBytes: 25 * 1024 * 1024,
        },
        transcription: {
          status: "unavailable",
          reason: "native-audio-unavailable",
        },
      },
    })
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.pick({
        interactions: true,
        content: true,
      }).parse(openCodeCapabilities())
    ).toBeTruthy()
  })
})
