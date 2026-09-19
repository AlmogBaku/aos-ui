import { INTERACTION_PROTOCOL } from "../../../protocol"

/** Normalized capability fragment for the pinned OpenCode v2 surface. */
export function openCodeCapabilities() {
  return {
    interactions: {
      steering: { status: "unavailable", reason: "native-steering-unproven" },
      approvals: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "run",
        choices: [
          { value: "once", scope: "request" },
          { value: "always", scope: "agent" },
          { value: "deny", scope: "request" },
        ],
        maxPending: 64,
      },
      questions: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "run",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-reject",
        maxQuestions: 32,
        maxChoicesPerQuestion: 64,
        maxAnswerValuesPerQuestion: 64,
        maxStringBytes: 4096,
      },
      reactions: {
        status: "unavailable",
        reason: "native-reaction-operation-unavailable",
      },
    },
    content: {
      attachments: {
        status: "available",
        scope: "attached-session",
        inputs: ["image", "file"],
        imageMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
        fileMimeTypes: "valid-type/subtype",
        maxMimeTypeBytes: 256,
        maxFilenameBytes: 255,
        maxCount: 16,
        maxImageBytes: 25 * 1024 * 1024,
        maxFileBytes: 25 * 1024 * 1024,
        maxTotalBytes: 25 * 1024 * 1024,
      },
      artifacts: {
        status: "unavailable",
        reason: "native-artifact-download-unavailable",
      },
      transcription: {
        status: "unavailable",
        reason: "native-audio-unavailable",
      },
      speech: { status: "unavailable", reason: "native-audio-unavailable" },
    },
  } as const
}
