import type { HgwWorkspaceCapabilities } from "@harness-gw/sdk"
import { INTERACTION_PROTOCOL } from "@harness-gw/sdk/protocol"

type Capabilities = HgwWorkspaceCapabilities

const unavailable = { status: "unavailable", reason: "not-supported" } as const

/** Approvals and questions as a runtime that asks one at a time reports them. */
export const singleInteractions = {
  approvals: {
    status: "available",
    protocol: INTERACTION_PROTOCOL,
    scope: "turn",
    choices: [{ value: "once", scope: "request" }],
    maxPending: 1,
  },
  questions: {
    status: "available",
    protocol: INTERACTION_PROTOCOL,
    scope: "turn",
    answerModes: ["single", "multiple", "free-text"],
    cancellation: "native-cancel",
    maxQuestions: 1,
    maxChoicesPerQuestion: 4,
    maxAnswerValuesPerQuestion: "complete-request",
    maxStringBytes: 4096,
  },
} as const satisfies Pick<
  Capabilities["interactions"],
  "approvals" | "questions"
>

/**
 * A Session's capability snapshot as `session/resume` reports it: every
 * capability unavailable except the ones a test names. Approvals and
 * questions have no unavailable form, so each test names its own.
 */
export function sessionCapabilities({
  workspace,
  interactions,
  content,
}: {
  workspace?: Partial<Capabilities["workspace"]>
  interactions: Pick<Capabilities["interactions"], "approvals" | "questions"> &
    Partial<Capabilities["interactions"]>
  content?: Partial<Capabilities["content"]>
}): Capabilities {
  return {
    workspace: {
      slashCommands: unavailable,
      models: unavailable,
      context: unavailable,
      todos: unavailable,
      activity: unavailable,
      ...workspace,
    },
    interactions: {
      steering: unavailable,
      rewind: unavailable,
      reactions: unavailable,
      ...interactions,
    },
    content: {
      attachments: unavailable,
      artifacts: unavailable,
      mcpApps: unavailable,
      transcription: unavailable,
      speech: unavailable,
      ...content,
    },
  }
}
