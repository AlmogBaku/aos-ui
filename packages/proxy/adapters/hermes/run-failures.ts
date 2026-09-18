/**
 * What a Hermes run may say about a failure, and to whom.
 *
 * The browser only ever sees one of the entries below: a stable AOS code and a
 * message AOS authored. Hermes' own error text is diagnosable in the server log
 * alone, redacted and bounded, and is never part of a public failure.
 */
import { redactForLog } from "../../redaction"
import { stableNativeId } from "./run-frames"

const MAX_LOGGED_NATIVE_CHARS = 200

/** The public shape of every terminal AOS failure: a code and its message. */
export type RunFailure = {
  readonly code: string
  readonly message: string
}

/**
 * The parts of a terminal Hermes failure AOS may act on. `nativeMessage` is
 * kept only for the redacted server log and never reaches the browser.
 */
export type NativeFailure = {
  layer?: string
  code?: string
  retryable?: boolean
  failureReason?: string
  nativeMessage?: string
}

export class HermesRunPublicError extends Error {
  readonly code: "AOS_PROVIDER_UNAVAILABLE" | "AOS_STOP_UNCERTAIN"

  constructor(
    code: "AOS_PROVIDER_UNAVAILABLE" | "AOS_STOP_UNCERTAIN",
    message: string
  ) {
    super(message)
    this.name = "HermesRunPublicError"
    this.code = code
  }
}

/** The requested rewind point no longer exists in authoritative Hermes history. */
export class HermesRunRewindConflictError extends Error {
  constructor() {
    super("The Hermes Session can no longer be rewound to that message")
    this.name = "HermesRunRewindConflictError"
  }
}

/** The names the run engine logs under; the only two lines it ever writes. */
export const RUN_NATIVE_ERROR_LOG = "hermes.run.native_error"
export const RUN_FAILED_LOG = "hermes.run.failed"

/** Every public run failure the Hermes adapter can publish. */
export const RUN_FAILURES = {
  resetRequired: {
    code: "AOS_RESET_REQUIRED",
    message: "Hermes history must be reconciled before this run can continue.",
  },
  connectionInterrupted: {
    code: "AOS_CONNECTION_INTERRUPTED",
    message:
      "The Hermes connection was interrupted; reconnect to reconcile this run.",
  },
  sendUncertain: {
    code: "AOS_SEND_UNCERTAIN",
    message:
      "Hermes may have accepted this turn; reconcile before sending again.",
  },
  interactionUncertain: {
    code: "AOS_INTERACTION_UNCERTAIN",
    message:
      "Hermes may have applied this interaction response; reconcile before responding again.",
  },
  interactionFailed: {
    code: "AOS_INTERACTION_FAILED",
    message: "Hermes could not apply this interaction response.",
  },
  interactionExpired: {
    code: "AOS_INTERACTION_EXPIRED",
    message: "This Hermes interaction is no longer pending.",
  },
  sessionBusy: {
    code: "AOS_SESSION_BUSY",
    message: "Hermes is already running this Session.",
  },
  rewindConflict: {
    code: "AOS_REWIND_CONFLICT",
    message:
      "This response can no longer be regenerated because Hermes history changed.",
  },
  commandWithAttachments: {
    code: "AOS_COMMAND_WITH_ATTACHMENTS",
    message: "Slash commands cannot be sent with attachments.",
  },
  commandRejected: {
    code: "AOS_PROVIDER_RUN_FAILED",
    message: "Hermes rejected this command.",
  },
  stopUncertain: {
    code: "AOS_STOP_UNCERTAIN",
    message: "Hermes could not confirm Stop; reconcile before sending again.",
  },
  streamOverflow: {
    code: "AOS_STREAM_OVERFLOW",
    message: "Hermes produced more events than AOS can safely buffer.",
  },
  agentUnavailable: {
    code: "AOS_PROVIDER_AGENT_UNAVAILABLE",
    message: "Hermes could not start the agent for this Session.",
  },
  billingFailed: {
    code: "AOS_PROVIDER_BILLING_FAILED",
    message: "Hermes reported a billing or quota problem.",
  },
  retryableFailure: {
    code: "AOS_PROVIDER_RETRYABLE_FAILURE",
    message: "Hermes hit a temporary provider error. Retry the message.",
  },
  runFailed: {
    code: "AOS_PROVIDER_RUN_FAILED",
    message: "Hermes could not complete this run.",
  },
} as const satisfies Record<string, RunFailure>

export function providerUnavailable() {
  return new HermesRunPublicError(
    "AOS_PROVIDER_UNAVAILABLE",
    "Hermes is temporarily unavailable."
  )
}

export function stopUncertain() {
  return new HermesRunPublicError(
    RUN_FAILURES.stopUncertain.code,
    RUN_FAILURES.stopUncertain.message
  )
}

/**
 * Hermes' own classification of a failure (`error_surface`, `failure_reason`)
 * plus the native text, which only the server log may see.
 */
export function nativeFailure(payload: Record<string, unknown>): NativeFailure {
  const surface = payload.error_surface
  const fields =
    typeof surface === "object" && surface !== null
      ? (surface as Record<string, unknown>)
      : {}
  const native = payload.error ?? payload.message
  return loggedFields({
    layer: stableNativeId(fields.layer),
    code: stableNativeId(fields.code),
    retryable:
      typeof fields.retryable === "boolean" ? fields.retryable : undefined,
    failureReason: stableNativeId(payload.failure_reason),
    nativeMessage:
      typeof native === "string" && native
        ? native.slice(0, MAX_LOGGED_NATIVE_CHARS)
        : undefined,
  })
}

/** Drop absent fields so nothing is recorded or logged as `undefined`. */
export function loggedFields<T extends Record<string, unknown>>(fields: T) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

/** Native text is diagnosable only in the server log, and only redacted. */
export function loggedNativeMessage(failure: NativeFailure | undefined) {
  return failure?.nativeMessage === undefined
    ? undefined
    : redactForLog(failure.nativeMessage)
}

/**
 * The public explanation of a failed native turn. Hermes' classification picks
 * the message; its own error text never leaves the server.
 */
export function publicRunFailure(failure: NativeFailure): RunFailure {
  const code = failure.code?.toLowerCase() ?? ""
  if (code === "agent_init_failed") return RUN_FAILURES.agentUnavailable
  if (failure.layer === "billing" || /billing|quota|insufficient/u.test(code))
    return RUN_FAILURES.billingFailed
  if (failure.retryable === true) return RUN_FAILURES.retryableFailure
  return RUN_FAILURES.runFailed
}
