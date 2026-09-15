import { describe, expect, it } from "vitest"
import { openClawCapabilities } from "./capabilities"
describe("OpenClaw capabilities", () =>
  it("keeps only proven operations available", () =>
    expect(openClawCapabilities()).toMatchObject({
      questions: { status: "available", protocol: "ag-ui-interrupt" },
      approvals: { allowedDecisions: "native-request" },
      attachments: { operation: "chat.send" },
      artifacts: {
        status: "unavailable",
        reason: "native-scoped-download-not-yet-proven",
      },
      audio: { status: "unavailable" },
      visibility: { status: "unavailable" },
      todos: { status: "unavailable" },
      editRetry: { status: "unavailable" },
      branches: { status: "unavailable" },
    })))
