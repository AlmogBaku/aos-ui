/** Exact capabilities proven by the pinned OpenCode v2 public SDK. */
export function openCodeCapabilities() {
  return {
    interactions: {
      questions: {
        available: true,
        protocol: "ag-ui-interrupt",
        scope: "session-run",
        limits: { maxQuestions: 32, maxOptionsPerQuestion: 64 },
      },
      permissions: {
        available: true,
        protocol: "ag-ui-interrupt",
        scope: "session-run",
        choices: ["once", "always", "reject"],
        limits: { maxResources: 64 },
      },
      reactions: {
        available: false,
        reason: "native-reaction-operation-unavailable",
      },
    },
    controls: {
      steering: { available: false, reason: "native-steering-unproven" },
      editRetry: { available: false, reason: "native-rewind-unproven" },
      commands: {
        available: false,
        reason: "native-command-execution-unavailable",
      },
    },
    content: {
      attachments: {
        available: true,
        scope: "new-turn",
        limits: { maxAttachments: 16, maxTotalBytes: 25 * 1024 * 1024 },
      },
      artifacts: {
        available: false,
        reason: "native-artifact-download-unavailable",
      },
      audio: { available: false, reason: "native-audio-unavailable" },
    },
  } as const
}
