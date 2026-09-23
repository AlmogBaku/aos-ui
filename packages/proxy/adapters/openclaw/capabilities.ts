import { INTERACTION_PROTOCOL } from "../../../protocol"
import { MAX_ARTIFACT_BYTES } from "../../core/artifact-path"
import { OPENCLAW_ATTACHMENT_PROXY_LIMITS } from "./content"
import type { OpenClawNegotiatedPolicy } from "./client"
import { OPENCLAW_MAX_PENDING_INTERACTIONS } from "./interactions"
import { OPENCLAW_MCP_APP_MAX_BYTES } from "./mcp-apps"

export type OpenClawCapabilityPolicy = OpenClawNegotiatedPolicy

/** Provider-neutral capability fragments built from the negotiated Gateway policy. */
export function openClawCapabilities(policy: OpenClawCapabilityPolicy) {
  if (
    !policy ||
    !Number.isSafeInteger(policy.maxPayload) ||
    policy.maxPayload < 1
  )
    throw new Error("Invalid OpenClaw capability policy")
  return {
    interactions: {
      steering: {
        status: "unavailable" as const,
        reason: "active-turn-steering-unavailable" as const,
      },
      approvals: {
        status: "available" as const,
        protocol: INTERACTION_PROTOCOL,
        scope: "turn" as const,
        choices: [
          { value: "once" as const, scope: "request" as const },
          { value: "always" as const, scope: "agent" as const },
          { value: "deny" as const, scope: "request" as const },
        ],
        maxPending: OPENCLAW_MAX_PENDING_INTERACTIONS,
      },
      questions: {
        status: "available" as const,
        protocol: INTERACTION_PROTOCOL,
        scope: "turn" as const,
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
      attachments: policy.attachments
        ? {
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
          }
        : {
            status: "unavailable" as const,
            reason: "negotiated-attachment-policy-unavailable",
          },
      artifacts: {
        status: "available" as const,
        scope: "session" as const,
        maxBytes: MAX_ARTIFACT_BYTES,
      },
      // A tool result opens a view only while the gateway's `mcp.apps` is on;
      // `describe` reads that per call, so the capability need not.
      mcpApps: {
        status: "available" as const,
        scope: "session" as const,
        maxBytes: OPENCLAW_MCP_APP_MAX_BYTES,
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
