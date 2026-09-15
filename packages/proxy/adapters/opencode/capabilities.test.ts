import { describe, expect, it } from "vitest"

import { openCodeCapabilities } from "./capabilities"

describe("openCodeCapabilities", () => {
  it("reports exact native choices and explicit unavailable operations", () => {
    expect(openCodeCapabilities()).toMatchObject({
      interactions: {
        questions: {
          available: true,
          protocol: "ag-ui-interrupt",
          scope: "session-run",
        },
        permissions: {
          available: true,
          choices: ["once", "always", "reject"],
        },
      },
      controls: {
        steering: { available: false, reason: "native-steering-unproven" },
        editRetry: { available: false, reason: "native-rewind-unproven" },
      },
      content: {
        audio: { available: false, reason: "native-audio-unavailable" },
      },
    })
  })
})
