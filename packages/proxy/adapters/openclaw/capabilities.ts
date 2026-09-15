import {
  OPENCLAW_ATTACHMENT_PROXY_LIMITS,
  type OpenClawGatewayPolicy,
} from "./content"
import { OPENCLAW_MAX_PENDING_INTERACTIONS } from "./interactions"

export type OpenClawCapabilityPolicy = OpenClawGatewayPolicy

/** Provider-neutral capability fragments built from the negotiated Gateway policy. */
export function openClawCapabilities(policy: OpenClawCapabilityPolicy) {
  if (
    !policy ||
    !policy.attachments ||
    !Number.isSafeInteger(policy.maxPayload) ||
    policy.maxPayload < 1 ||
    !Number.isSafeInteger(policy.attachments.maxBytes) ||
    policy.attachments.maxBytes < 1 ||
    !Number.isSafeInteger(policy.attachments.maxImageBytes) ||
    policy.attachments.maxImageBytes < 1
  )
    throw new Error("Invalid OpenClaw capability policy")
  return {
    interactions: {
      steering: {
        status: "unavailable" as const,
        reason: "active-run-steering-unavailable" as const,
      },
      approvals: {
        status: "available" as const,
        protocol: "ag-ui-interrupt" as const,
        scope: "run" as const,
        choices: [
          { value: "once" as const, scope: "request" as const },
          { value: "always" as const, scope: "agent" as const },
          { value: "deny" as const, scope: "request" as const },
        ],
        maxPending: OPENCLAW_MAX_PENDING_INTERACTIONS,
      },
      questions: {
        status: "available" as const,
        protocol: "ag-ui-interrupt" as const,
        scope: "run" as const,
        answerModes: ["single", "multiple", "free-text"] as const,
        cancellation: "native-cancel" as const,
        maxQuestions: 3,
        maxChoicesPerQuestion: 4,
        maxAnswerValuesPerQuestion: "complete-request" as const,
        maxStringBytes: 4096,
      },
      reactions: {
        status: "unavailable" as const,
        reason: "interaction-reactions-unavailable" as const,
      },
    },
    content: {
      attachments: {
        status: "available" as const,
        scope: "attached-session" as const,
        inputs: ["image", "file"] as const,
        imageMimeTypes: "provider-dependent" as const,
        fileMimeTypes: "provider-dependent" as const,
        ...OPENCLAW_ATTACHMENT_PROXY_LIMITS,
        maxImageBytes: policy.attachments.maxImageBytes,
        maxFileBytes: policy.attachments.maxBytes,
        maxTotalBytes: "complete-request" as const,
        maxEncodedRequestBytes: policy.maxPayload,
        completeRequestValidation: "native-run-input" as const,
      },
      artifacts: {
        status: "unavailable" as const,
        reason: "artifact-publication-unavailable" as const,
      },
      transcription: {
        status: "unavailable" as const,
        reason: "audio-transcription-unavailable" as const,
      },
      speech: {
        status: "unavailable" as const,
        reason: "audio-speech-unavailable" as const,
      },
    },
  }
}
