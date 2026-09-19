import {
  EventType,
  type AGUIEvent,
  type Interrupt,
  type ResumeEntry,
  type RunAgentInput,
} from "@ag-ui/core"

/**
 * Proxy-owned run vocabulary.
 *
 * Phase A: aliases over the shapes the adapters emit today, so the coordinator
 * and the ACP layer are written once against these names. Phase E replaces the
 * aliases with proxy-owned definitions and removes `@ag-ui/core` from the
 * repository. Nothing outside `adapters/**` and this module may import
 * `@ag-ui`.
 */
export type RunEvent = AGUIEvent
export { EventType as RunEventKind }
export type RunEventOf<Kind extends RunEvent["type"]> = Extract<
  RunEvent,
  { type: Kind }
>

/** A question or approval the provider is waiting on; it ends a run segment. */
export type PendingRequest = Interrupt
/** The operator's answer to one pending request; it starts the next segment. */
export type RequestReply = ResumeEntry
/** One admitted user turn, or a batch of request replies. */
export type TurnInput = RunAgentInput

/** Error codes after which Send, Stop, steer, and replies must not be retried. */
export const UNCERTAIN_ERROR_CODES = [
  "AOS_SEND_UNCERTAIN",
  "AOS_INTERACTION_UNCERTAIN",
  "AOS_CONNECTION_INTERRUPTED",
  "AOS_RESET_REQUIRED",
] as const
export type UncertainErrorCode = (typeof UNCERTAIN_ERROR_CODES)[number]

export function isUncertainError(event: RunEvent): boolean {
  return (
    event.type === EventType.RUN_ERROR &&
    (UNCERTAIN_ERROR_CODES as readonly string[]).includes(event.code ?? "")
  )
}

/**
 * Workspace-wide execution events published by the coordinator observer for
 * every Session it drives, independent of run-stream subscribers. Timestamps
 * are RFC 3339 strings.
 */
export type ExecutionEvent = {
  agentId: string
  sessionId: string
  runId: string
  occurredAt: string
} & (
  | { type: "run-started" | "run-finished" | "run-failed" }
  | { type: "attention-requested"; request: PendingRequest }
  | { type: "attention-resolved"; interruptId: string }
)

/** Pending requests carried by a segment's terminal event, if any. */
export function pendingRequestsOf(event: RunEvent): PendingRequest[] {
  if (event.type !== EventType.RUN_FINISHED) return []
  const outcome = event.outcome
  if (
    !outcome ||
    typeof outcome !== "object" ||
    !("type" in outcome) ||
    outcome.type !== "interrupt" ||
    !("interrupts" in outcome) ||
    !Array.isArray(outcome.interrupts)
  )
    return []
  return outcome.interrupts
}
