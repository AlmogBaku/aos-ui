/**
 * What a Hermes turn may say about a failure, and to whom.
 *
 * Every public failure is one of the entries below: a stable AOS code and the
 * headline AOS authored for it. A failure the operator has to act on also needs
 * the provider's own words, so Hermes' error text follows the headline as a
 * second line — bounded, and dropped whole when it carries anything the
 * adapter's redaction rule keeps private. The server log keeps its own shorter,
 * redacted copy.
 */
import { redactForLog } from "../../redaction"
import { containsCredentialValue, trimmedText } from "./native"
import { stableNativeId } from "./run-frames"

const MAX_LOGGED_NATIVE_CHARS = 200
/** How much of Hermes' own error text a public failure may carry. */
const MAX_PUBLIC_DETAIL_CHARS = 500

/** The public shape of every terminal AOS failure: a code and its message. */
export type TurnFailure = {
  readonly code: string
  readonly message: string
}

/**
 * The parts of a terminal Hermes failure AOS may act on. `nativeMessage` is the
 * longer copy only the redacted server log sees; `detail` is the bounded,
 * redaction-checked cause a public failure may carry.
 */
export type NativeFailure = {
  layer?: string
  code?: string
  retryable?: boolean
  failureReason?: string
  nativeMessage?: string
  detail?: string
}

export class HermesTurnPublicError extends Error {
  readonly code: "AOS_PROVIDER_UNAVAILABLE" | "AOS_STOP_UNCERTAIN"

  constructor(
    code: "AOS_PROVIDER_UNAVAILABLE" | "AOS_STOP_UNCERTAIN",
    message: string
  ) {
    super(message)
    this.name = "HermesTurnPublicError"
    this.code = code
  }
}

/** The requested rewind point no longer exists in authoritative Hermes history. */
export class HermesTurnRewindConflictError extends Error {
  constructor() {
    super("The Hermes Session can no longer be rewound to that message")
    this.name = "HermesTurnRewindConflictError"
  }
}

/** The names the turn engine logs under; the only two lines it ever writes. */
export const TURN_NATIVE_ERROR_LOG = "hermes.turn.native_error"
export const TURN_FAILED_LOG = "hermes.turn.failed"

/** Every public turn failure the Hermes adapter can publish. */
export const TURN_FAILURES = {
  resetRequired: {
    code: "AOS_RESET_REQUIRED",
    message: "Hermes history must be reconciled before this turn can continue.",
  },
  connectionInterrupted: {
    code: "AOS_CONNECTION_INTERRUPTED",
    message:
      "The Hermes connection was interrupted; reconnect to reconcile this turn.",
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
  interactionLost: {
    code: "AOS_INTERACTION_LOST",
    message:
      "This Session is waiting on a question that can no longer be answered here. Stop the turn to continue.",
  },
  sessionInUse: {
    code: "AOS_SESSION_IN_USE",
    message:
      "This Session is open in another app. Use it there, or start a new Session.",
  },
  sessionLimit: {
    code: "AOS_SESSION_LIMIT",
    message: "Hermes has reached its limit of active Sessions.",
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
  // Hermes marks a rejection retryable without knowing whether it is
  // deterministic (a model that refuses this request shape rejects it again),
  // so the copy instructs rather than promising a successful retry.
  retryableFailure: {
    code: "AOS_PROVIDER_RETRYABLE_FAILURE",
    message:
      "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.",
  },
  turnFailed: {
    code: "AOS_PROVIDER_RUN_FAILED",
    message: "Hermes could not complete this turn.",
  },
} as const satisfies Record<string, TurnFailure>

export function providerUnavailable() {
  return new HermesTurnPublicError(
    "AOS_PROVIDER_UNAVAILABLE",
    "Hermes is temporarily unavailable."
  )
}

export function stopUncertain() {
  return new HermesTurnPublicError(
    TURN_FAILURES.stopUncertain.code,
    TURN_FAILURES.stopUncertain.message
  )
}

/**
 * Hermes' own error text, bounded and only when it carries no credential. The
 * bounded text is what the check reads, because that is all that ever leaves:
 * a value that trips the rule is dropped whole rather than masked. A path or an
 * internal location stays, because the operator acts on it; the guest lane
 * replaces every failure message with its own catalogue's description.
 */
export function publicDetail(value: unknown) {
  const native = trimmedText(value)
  if (native === undefined) return undefined
  const detail = native.slice(0, MAX_PUBLIC_DETAIL_CHARS).trim()
  return containsCredentialValue(detail) ? undefined : detail
}

/**
 * Hermes' own classification of a failure (`error_surface`, `failure_reason`)
 * plus its native text, bounded once for the server log and once for the public
 * detail a failure may carry.
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
    detail: publicDetail(native),
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
 * The public explanation of a failed native turn: the headline Hermes'
 * classification picks, followed by the bounded native cause when there is one
 * to act on. The headline stays the first line, so a client that localizes by
 * code replaces exactly that line and keeps the provider's own words.
 */
export function publicTurnFailure(failure: NativeFailure): TurnFailure {
  return withDetail(turnFailureHeadline(failure), failure.detail)
}

/** A headline followed by Hermes' own public detail as its second line. */
export function withDetail(
  headline: TurnFailure,
  detail: string | undefined
): TurnFailure {
  return detail === undefined
    ? headline
    : { code: headline.code, message: `${headline.message}\n${detail}` }
}

/** Hermes' classification, mapped to the one catalogue entry that explains it. */
function turnFailureHeadline(failure: NativeFailure): TurnFailure {
  const code = failure.code?.toLowerCase() ?? ""
  if (code === "agent_init_failed") return TURN_FAILURES.agentUnavailable
  if (failure.layer === "billing" || /billing|quota|insufficient/u.test(code))
    return TURN_FAILURES.billingFailed
  if (failure.retryable === true) return TURN_FAILURES.retryableFailure
  return TURN_FAILURES.turnFailed
}
