const limits = Object.freeze({
  maxCount: 16,
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  completeRequestValidation: "official-chat.send" as const,
})
/** Exact adapter capabilities; nearby Gateway methods never imply support. */
export function openClawCapabilities() {
  return {
    questions: {
      status: "available" as const,
      protocol: "ag-ui-interrupt" as const,
      scope: "run" as const,
      operation: "question.resolve" as const,
      response: "complete-native-batch" as const,
      expiry: "native-request" as const,
      uncertainty: "never-replay" as const,
      maxQuestions: 32,
      maxOptionsPerQuestion: 64,
    },
    approvals: {
      status: "available" as const,
      protocol: "ag-ui-interrupt" as const,
      scope: "run" as const,
      operation: "approval.resolve" as const,
      allowedDecisions: "native-request" as const,
      expiry: "native-request" as const,
      uncertainty: "never-replay" as const,
    },
    attachments: {
      status: "available" as const,
      scope: "session" as const,
      operation: "chat.send" as const,
      inputs: ["image", "file"] as const,
      limits,
    },
    artifacts: {
      status: "available" as const,
      scope: "agent-session-message" as const,
      operation: "artifacts.download" as const,
      receipt: "exact-native-identity-bound" as const,
      downloadModes: ["bytes"] as const,
    },
    richPresentation: {
      status: "available" as const,
      source: "optional-aos-plugin" as const,
      fallback: "inspectable-text" as const,
    },
    audio: {
      status: "unavailable" as const,
      reason: "no-complete-agent-audio-operation" as const,
    },
    visibility: {
      status: "unavailable" as const,
      reason: "native-semantic-equivalent-unavailable" as const,
    },
    todos: {
      status: "unavailable" as const,
      reason: "native-session-todos-unavailable" as const,
    },
    editRetry: {
      status: "unavailable" as const,
      reason: "native-authoritative-rewind-unavailable" as const,
    },
    branches: {
      status: "unavailable" as const,
      reason: "native-session-branches-unavailable" as const,
    },
    reactions: {
      status: "unavailable" as const,
      reason: "native-reaction-operation-unavailable" as const,
    },
  }
}
