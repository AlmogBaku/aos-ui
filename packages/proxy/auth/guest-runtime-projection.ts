import {
  GuestRuntimeCapabilitiesResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
} from "../../protocol"
import type { GuestAuthorization } from "./guest-invitation"
import {
  guestErrorDescription,
  projectGuestOutbound,
  type GuestPublicErrorCode,
} from "./guest-projection"

/** Whether a user turn is an invitation's setup envelope, whatever it asks. */
export function isFirstTurnEnvelope(content: unknown) {
  if (!Array.isArray(content) || content.length !== 1) return false
  const part = content[0]
  if (part?.type !== "text") return false
  try {
    const value = JSON.parse(part.text) as unknown
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).v === 1 &&
      (value as Record<string, unknown>).type === "aos.guest.first-turn"
    )
  } catch {
    return false
  }
}

export function projectGuestError(
  authorization: GuestAuthorization,
  code: GuestPublicErrorCode,
  retryable: boolean,
  status: number
) {
  const projected = projectGuestOutbound(
    {
      transport: "error",
      agentId: authorization.agentId,
      sessionId: authorization.sessionId,
      payload: {
        type: "error",
        code,
        description: guestErrorDescription(code),
        retryable,
      },
    },
    authorization
  )
  return projected?.payload.type === "error"
    ? new Response(
        JSON.stringify({
          error: {
            code:
              projected.payload.code === "rate_limited"
                ? "turn_capacity_exceeded"
                : projected.payload.code === "request_failed"
                  ? "turn_conflict"
                  : projected.payload.code,
            description:
              projected.payload.description ??
              guestErrorDescription(projected.payload.code),
          },
        }),
        {
          status,
          headers: { "content-type": "application/json; charset=UTF-8" },
        }
      )
    : new Response(null, { status })
}

/**
 * One message's text as the guest may read it. A user turn projects under the
 * `guest` role whoever sent it; `undefined` means the guest sees none of it.
 */
export function projectGuestText(
  authorization: GuestAuthorization,
  role: "guest" | "assistant",
  text: string
) {
  const projected = projectGuestOutbound(
    {
      transport: "rest",
      agentId: authorization.agentId,
      sessionId: authorization.sessionId,
      payload: { type: "message", role, text },
    },
    authorization
  )
  return projected?.payload.type === "message"
    ? projected.payload.text
    : undefined
}

export function projectGuestCapabilities(value: unknown) {
  const parsed = SessionWorkspaceCapabilitiesResponseSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { content, interactions, workspace } = parsed.data
  return GuestRuntimeCapabilitiesResponseSchema.parse({
    workspace: { slashCommands: workspace.slashCommands },
    content,
    interactions: {
      ...interactions,
      steering: {
        status: "unavailable",
        reason: "operator-turn-control-required",
      },
      approvals: {
        ...interactions.approvals,
        choices: interactions.approvals.choices.filter(
          ({ value }) => value !== "always"
        ),
      },
    },
  })
}

/**
 * Guest-visible turn failures. Only a code a guest client can act on keeps its
 * identity; every other normalized failure collapses into a generic one.
 */
const guestTurnErrors: Readonly<
  Record<string, { code: GuestPublicErrorCode; retryable: boolean }>
> = {
  AOS_CONNECTION_INTERRUPTED: {
    code: "AOS_CONNECTION_INTERRUPTED",
    retryable: true,
  },
  AOS_SEND_UNCERTAIN: { code: "AOS_SEND_UNCERTAIN", retryable: true },
  AOS_INTERACTION_UNCERTAIN: {
    code: "AOS_INTERACTION_UNCERTAIN",
    retryable: true,
  },
  AOS_STOP_UNCERTAIN: { code: "AOS_STOP_UNCERTAIN", retryable: true },
  AOS_RESET_REQUIRED: { code: "temporarily_unavailable", retryable: true },
  AOS_STREAM_OVERFLOW: { code: "temporarily_unavailable", retryable: true },
  AOS_PROVIDER_RETRYABLE_FAILURE: {
    code: "temporarily_unavailable",
    retryable: true,
  },
  AOS_PROVIDER_AGENT_UNAVAILABLE: {
    code: "temporarily_unavailable",
    retryable: true,
  },
  AOS_PROVIDER_UNAVAILABLE: {
    code: "temporarily_unavailable",
    retryable: true,
  },
  AOS_SESSION_BUSY: { code: "rate_limited", retryable: true },
  AOS_SESSION_LIMIT: { code: "rate_limited", retryable: true },
}

export function publicTurnError(code: string | undefined) {
  // Only an own entry names a guest-visible failure: an inherited object key
  // must collapse into the generic one like any unknown code.
  return (
    (code !== undefined && Object.hasOwn(guestTurnErrors, code)
      ? guestTurnErrors[code]
      : undefined) ?? {
      code: "request_failed" as const,
      retryable: false,
    }
  )
}
