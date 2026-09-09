import { describe, expect, it, vi } from "vitest"

import type { HermesApproval } from "./hermes-native-client"
import {
  projectHermesApprovalMessages,
  respondToHermesApproval,
} from "./hermes-approval"

const approval: HermesApproval = {
  threadId: "thread-one",
  liveSessionId: "live-one",
  requestId: "approval-one",
  message: "Use the network?",
  choices: ["once", "session", "always", "deny"],
}

describe("Hermes native tool approvals", () => {
  it("attaches the pending request to the guarded tool with native Assistant UI options", () => {
    const messages = projectHermesApprovalMessages(
      [
        {
          id: "assistant-one",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "bash-one",
              toolName: "bash",
              args: { command: "curl example.com" },
              argsText: '{"command":"curl example.com"}',
            },
          ],
        },
      ],
      approval,
      "en"
    )

    expect(messages[0]).toMatchObject({
      status: { type: "requires-action", reason: "tool-calls" },
      content: [
        {
          toolCallId: "bash-one",
          approval: {
            id: "approval-one",
            prompt: "Use the network?",
            options: [
              { id: "once", kind: "allow-once", label: "Allow once" },
              {
                id: "session",
                kind: "allow-always",
                label: "Allow for this session",
              },
              {
                id: "always",
                kind: "allow-always",
                label: "Always allow",
              },
              { id: "deny", kind: "reject-once", label: "Deny" },
            ],
          },
        },
      ],
    })
  })

  it("forwards the native approval identity and selected scope", async () => {
    const client = { answerApproval: vi.fn().mockResolvedValue(undefined) }

    await respondToHermesApproval(client, "thread-one", {
      approvalId: "approval-one",
      approved: true,
      optionId: "session",
    })

    expect(client.answerApproval).toHaveBeenCalledWith(
      "thread-one",
      "approval-one",
      "session"
    )
  })

  it("adds one stable permission part when Hermes has no guarded tool part", () => {
    const messages = projectHermesApprovalMessages(
      [
        {
          id: "assistant-one",
          role: "assistant",
          content: "Checking access.",
        },
      ],
      approval,
      "he"
    )

    expect(messages[0]).toMatchObject({
      content: [
        { type: "text", text: "Checking access." },
        {
          type: "tool-call",
          toolCallId: "hermes-approval-approval-one",
          toolName: "request_permission",
          args: { action: "Use the network?" },
          approval: {
            id: "approval-one",
            options: [
              { id: "once", label: "אישור פעם אחת" },
              { id: "session", label: "אישור לשיחה זו" },
              { id: "always", label: "אישור תמיד" },
              { id: "deny", label: "דחייה" },
            ],
          },
        },
      ],
    })
  })
})
