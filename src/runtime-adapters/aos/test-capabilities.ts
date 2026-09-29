import type { AosWorkspaceCapabilities } from "./aos-client"

type Capabilities = AosWorkspaceCapabilities

const unavailable = { status: "unavailable", reason: "not-supported" } as const

/**
 * A Session's capability snapshot as `session/resume` reports it: every
 * capability unavailable except the ones a test names.
 */
export function sessionCapabilities({
  workspace,
  interactions,
  content,
}: {
  workspace?: Partial<Capabilities["workspace"]>
  interactions?: Partial<Capabilities["interactions"]>
  content?: Partial<Capabilities["content"]>
} = {}): Capabilities {
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
      approvals: unavailable,
      questions: unavailable,
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
