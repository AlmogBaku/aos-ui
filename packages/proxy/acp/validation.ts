import { RequestError } from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import { AOS_JSONRPC_ERRORS, AOS_META_KEY } from "../../protocol/acp"
import {
  ServerRequestStaleError,
  ServerTurnConflictError,
  ServerTurnEndedError,
} from "../core/runtime"
import { coreFailure, failureOf, type PublicFailure } from "../core/failures"
import { MembershipDetachedError } from "../core/channel"
import { ServerClientIdReusedError } from "../core/session-coordinator"
import type { CommandRefusal } from "../core/member"
import type { PublicErrors } from "./socket"
import type { AcpConnectionContext } from "./types"

/**
 * The two things the ACP v2 SDK cannot validate for us: the `_meta.aos`
 * payloads the shared contract defines, and the JSON-RPC error a proxy
 * failure travels as. An error ACP defines is the SDK's own `RequestError`;
 * only the rest take their code from `AOS_JSONRPC_ERRORS`.
 */

type AcpMeta = { readonly [key: string]: unknown } | null | undefined

/**
 * Parses `_meta.aos` with its contract schema. An absent envelope parses as an
 * empty object, so a schema whose fields are all optional accepts a request
 * that carries no AOS metadata at all.
 */
export function parseMeta<Schema extends z.ZodType>(
  schema: Schema,
  meta: AcpMeta
): z.output<Schema> {
  const parsed = schema.safeParse(meta?.[AOS_META_KEY] ?? {})
  if (!parsed.success) throw invalidParams()
  return parsed.data
}

/** `hint` says what a valid request looks like, for an operator client. */
export function invalidParams(hint?: string) {
  return RequestError.invalidParams(undefined, hint)
}

/**
 * The guest listener's answer to anything it has not redeemed an invitation
 * for.
 */
export function authenticationRequired() {
  return RequestError.authRequired()
}

export function notFound() {
  return RequestError.resourceNotFound()
}

/** The JSON-RPC error a member stack's refusal travels as. */
export function refusalError(refusal: CommandRefusal) {
  switch (refusal) {
    case "invalid":
      return invalidParams()
    case "not-found":
      return notFound()
    case "authentication-required":
      return authenticationRequired()
  }
}

export function turnInProgress() {
  return new RequestError(AOS_JSONRPC_ERRORS.turnInProgress, "turn_in_progress")
}

export function temporarilyUnavailable() {
  return new RequestError(
    AOS_JSONRPC_ERRORS.temporarilyUnavailable,
    "temporarily_unavailable"
  )
}

export function staleRequest() {
  return new RequestError(AOS_JSONRPC_ERRORS.staleRequest, "stale_request")
}

function revisionConflict() {
  return new RequestError(
    AOS_JSONRPC_ERRORS.revisionConflict,
    "revision_conflict"
  )
}

function uncertainMutation() {
  return new RequestError(
    AOS_JSONRPC_ERRORS.uncertainMutation,
    "uncertain_mutation"
  )
}

/** `hint` says what the deployment lacks, for an operator client. */
export function unsupported(hint?: string) {
  return new RequestError(
    AOS_JSONRPC_ERRORS.unsupported,
    hint === undefined ? "unsupported" : `unsupported: ${hint}`
  )
}

/** The error each kind of public failure travels as. */
const KIND_ERRORS: Readonly<Record<PublicFailure["kind"], () => RequestError>> =
  {
    gone: notFound,
    unavailable: temporarilyUnavailable,
    uncertain: uncertainMutation,
    invalid_request: invalidParams,
    revision_conflict: revisionConflict,
    runtime_authentication_required: authenticationRequired,
    unsupported,
  }

/**
 * Every error code a public reply carries, with the machine name it travels
 * as: the message of a public reply, and the code an `_aos/error` reports.
 */
const PUBLIC_ERROR_NAMES: ReadonlyMap<number, string> = new Map(
  (
    [
      [invalidParams(), "invalid_request"],
      [authenticationRequired(), "authentication_required"],
      [notFound(), "not_found"],
      [RequestError.methodNotFound(""), "method_not_found"],
      [RequestError.requestCancelled(), "request_cancelled"],
      [turnInProgress(), "turn_in_progress"],
      [staleRequest(), "stale_request"],
      [revisionConflict(), "revision_conflict"],
      [temporarilyUnavailable(), "temporarily_unavailable"],
      [uncertainMutation(), "uncertain_mutation"],
      [unsupported(), "unsupported"],
    ] as const
  ).map(([error, name]) => [error.code, name])
)

/** Every code an `_aos/error` notification reports a failure with. */
const PUBLIC_NOTICE_CODES: ReadonlySet<string> = new Set([
  ...PUBLIC_ERROR_NAMES.values(),
  "internal_error",
])

/**
 * A failure as a public client may read it: a public code, and never the
 * detail a failure carries. Any other reply is reported temporarily
 * unavailable, and any other notice code as an internal error.
 */
export const PUBLIC_ERRORS: PublicErrors = {
  reply(code) {
    const name =
      typeof code === "number" ? PUBLIC_ERROR_NAMES.get(code) : undefined
    return name === undefined
      ? {
          code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
          message: "temporarily_unavailable",
        }
      : { code: code as number, message: name }
  },
  notice: (code) =>
    typeof code === "string" && PUBLIC_NOTICE_CODES.has(code)
      ? code
      : "internal_error",
}

/** The failure a membership or send error is; the rest are core's own. */
function channelFailure(cause: unknown) {
  if (cause instanceof MembershipDetachedError)
    return failureOf("unavailable", cause)
  if (cause instanceof ServerClientIdReusedError)
    return failureOf("invalid_request", cause)
  return coreFailure(cause)
}

/**
 * The JSON-RPC error a proxy failure travels as, or the failure itself;
 * `publicError` is the runtime's classifier. A turn's own control answers
 * are ACP's; every other failure travels as its kind.
 */
export function publicRequestError(
  publicError: AcpConnectionContext["publicError"],
  cause: unknown
) {
  if (cause instanceof ServerTurnConflictError) return turnInProgress()
  if (cause instanceof ServerRequestStaleError) return staleRequest()
  if (cause instanceof ServerTurnEndedError && cause.ending === "stopped")
    return RequestError.requestCancelled()
  const failure = channelFailure(cause) ?? publicError(cause)
  return failure ? KIND_ERRORS[failure.kind]() : cause
}

/** The machine name a public reply carries `error` as, or `internal_error`. */
export function publicCodeOf(error: unknown) {
  return (
    (error instanceof RequestError && PUBLIC_ERROR_NAMES.get(error.code)) ||
    "internal_error"
  )
}

/**
 * The code and message an `_aos/error` notification reports a failure with.
 * The proxy has no operator-facing copy: a public failure travels as its
 * machine code, and the browser owns the localized sentence.
 */
export function errorNotificationOf(
  publicError: AcpConnectionContext["publicError"],
  cause: unknown
) {
  const code = publicCodeOf(publicRequestError(publicError, cause))
  return { code, message: code }
}
