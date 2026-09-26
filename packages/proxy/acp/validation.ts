import { RequestError } from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import { AOS_JSONRPC_ERRORS, AOS_META_KEY } from "../../protocol/acp"
import {
  ServerRequestStaleError,
  ServerTurnCapacityError,
  ServerTurnConflictError,
  ServerTurnSteerUnavailableError,
  ServerTurnSteerUncertainError,
  ServerSessionNotFoundError,
  type ServerRuntime,
  type ServerRuntimePublicError,
} from "../core/runtime"
import { MembershipDetachedError } from "../core/channel"
import { ServerClientIdReusedError } from "../core/session-coordinator"
import type { CommandRefusal } from "../core/member"
import type { PublicErrors } from "./socket"

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
  if (!parsed.success) throw invalidRequest()
  return parsed.data
}

export function invalidRequest() {
  return RequestError.invalidParams()
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
      return invalidRequest()
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

/** The error each public runtime failure travels as. */
const RUNTIME_ERRORS: Readonly<
  Record<ServerRuntimePublicError["code"], () => RequestError>
> = {
  runtime_authentication_required: authenticationRequired,
  invalid_request: invalidRequest,
  not_found: notFound,
  revision_conflict: revisionConflict,
  temporarily_unavailable: temporarilyUnavailable,
  // A dropped connection is a failure the next attempt may not meet.
  connection_interrupted: temporarilyUnavailable,
  uncertain_mutation: uncertainMutation,
}

/**
 * Every error code a public reply carries, with the machine name it travels
 * as: the message of a public reply, and the code an `_aos/error` reports.
 */
const PUBLIC_ERROR_NAMES: ReadonlyMap<number, string> = new Map(
  (
    [
      [invalidRequest(), "invalid_request"],
      [authenticationRequired(), "authentication_required"],
      [notFound(), "not_found"],
      [RequestError.methodNotFound(""), "method_not_found"],
      [RequestError.requestCancelled(), "request_cancelled"],
      [turnInProgress(), "turn_in_progress"],
      [staleRequest(), "stale_request"],
      [revisionConflict(), "revision_conflict"],
      [temporarilyUnavailable(), "temporarily_unavailable"],
      [uncertainMutation(), "uncertain_mutation"],
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
  reply({ code }) {
    const name = PUBLIC_ERROR_NAMES.get(code)
    return name === undefined
      ? {
          code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
          message: "temporarily_unavailable",
        }
      : { code, message: name }
  },
  notice: (code) =>
    typeof code === "string" && PUBLIC_NOTICE_CODES.has(code)
      ? code
      : "internal_error",
}

/** Coordinator control failures, mirroring the normalized HTTP error map. */
function coordinatorError(cause: unknown) {
  if (cause instanceof ServerTurnConflictError) return turnInProgress()
  if (cause instanceof ServerRequestStaleError) return staleRequest()
  if (
    cause instanceof ServerTurnCapacityError ||
    cause instanceof ServerTurnSteerUnavailableError ||
    cause instanceof MembershipDetachedError
  )
    return temporarilyUnavailable()
  if (cause instanceof ServerTurnSteerUncertainError) return uncertainMutation()
  if (cause instanceof ServerSessionNotFoundError) return notFound()
  if (cause instanceof ServerClientIdReusedError) return invalidRequest()
  return undefined
}

/** The JSON-RPC error a proxy failure travels as, or the failure itself. */
export function publicRequestError(runtime: ServerRuntime, cause: unknown) {
  const mapped = coordinatorError(cause)
  if (mapped) return mapped
  const publicError = runtime.publicError(cause)
  return publicError ? RUNTIME_ERRORS[publicError.code]() : cause
}

/**
 * The code and message an `_aos/error` notification reports a failure with.
 * The proxy has no operator-facing copy: a public failure travels as its
 * machine code, and the browser owns the localized sentence.
 */
export function errorNotificationOf(runtime: ServerRuntime, cause: unknown) {
  const mapped = publicRequestError(runtime, cause)
  const code =
    (mapped instanceof RequestError && PUBLIC_ERROR_NAMES.get(mapped.code)) ||
    "internal_error"
  return { code, message: code }
}
