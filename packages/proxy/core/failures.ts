/**
 * What a failure means to its caller, apart from any wire. A failure is one of
 * three kinds, or an error the caller made and a retry would meet again:
 *
 * - `gone`: what the request named no longer exists; nothing brings it back.
 * - `unavailable`: nothing happened; the same request may succeed later.
 * - `uncertain`: a write may have landed; reconcile before trying it again.
 *
 * A read is never uncertain. Only an adapter knows whether a write went out,
 * so it reports its own timed-out write as uncertain, and a bare deadline that
 * reaches this module is taken as a call that changed nothing. The native
 * error travels along as `cause`; each wire maps a kind to its own code.
 */
import {
  ServerAgentUpdateUnsupportedError,
  ServerSessionNotFoundError,
  ServerTurnCapacityError,
  ServerTurnSteerUnavailableError,
  ServerTurnSteerUncertainError,
  ServerTurnUncertainError,
} from "./runtime"

export type FailureKind = "gone" | "unavailable" | "uncertain"
export type CallerError =
  | "invalid_request"
  | "revision_conflict"
  | "runtime_authentication_required"
  | "unsupported"

export type PublicFailure = {
  readonly kind: FailureKind | CallerError
  readonly code: string
  readonly cause: unknown
}

type FailureTable = Readonly<
  Record<string, { readonly kind: FailureKind | CallerError }>
>

/** The machine code a failure classified by kind alone carries. */
const KIND_CODES = {
  gone: "not_found",
  unavailable: "temporarily_unavailable",
  uncertain: "uncertain_mutation",
  invalid_request: "invalid_request",
  revision_conflict: "revision_conflict",
  runtime_authentication_required: "runtime_authentication_required",
  unsupported: "unsupported",
} as const satisfies Record<PublicFailure["kind"], string>

/** A failure a runtime classified by its kind. */
export function failureOf(
  kind: PublicFailure["kind"],
  cause: unknown
): PublicFailure {
  return { kind, code: KIND_CODES[kind], cause }
}

/** The failure `table` names by the code `cause` carries, if it names one. */
export function publicFailure(
  cause: unknown,
  table: FailureTable
): PublicFailure | undefined {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : undefined
  if (typeof code !== "string" || !Object.hasOwn(table, code)) return undefined
  return { kind: table[code]!.kind, code, cause }
}

/** The turn failure codes a public client may act on, by kind. */
export const TURN_FAILURES = {
  AOS_SEND_UNCERTAIN: { kind: "uncertain" },
  AOS_INTERACTION_UNCERTAIN: { kind: "uncertain" },
  AOS_STOP_UNCERTAIN: { kind: "uncertain" },
  AOS_CONNECTION_INTERRUPTED: { kind: "uncertain" },
  AOS_RESET_REQUIRED: { kind: "uncertain" },
  // No reconcile confirmed the turn before its deadline: it may have run.
  AOS_OUTCOME_UNKNOWN: { kind: "uncertain" },
} as const satisfies FailureTable

/** The failure a proxy-core error is, whatever the runtime behind it. */
export function coreFailure(cause: unknown): PublicFailure | undefined {
  if (cause instanceof ServerSessionNotFoundError)
    return failureOf("gone", cause)
  if (cause instanceof ServerAgentUpdateUnsupportedError)
    return failureOf("unsupported", cause)
  if (
    cause instanceof ServerTurnCapacityError ||
    cause instanceof ServerTurnSteerUnavailableError ||
    // A bare deadline: its adapter left it a call that changed nothing.
    (cause instanceof DOMException && cause.name === "TimeoutError")
  )
    return failureOf("unavailable", cause)
  if (
    cause instanceof ServerTurnSteerUncertainError ||
    // A start past its admission deadline may have landed.
    cause instanceof ServerTurnUncertainError
  )
    return failureOf("uncertain", cause)
  return undefined
}
