import { RequestError } from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import { AOS_JSONRPC_ERRORS, AOS_META_KEY } from "../../protocol/acp"
import {
  ServerRequestStaleError,
  ServerTurnCapacityError,
  ServerTurnConflictError,
  ServerTurnControlError,
  ServerTurnSteerUnavailableError,
  ServerTurnSteerUncertainError,
  ServerSessionNotFoundError,
  type ServerRuntime,
  type ServerRuntimePublicError,
} from "../core/runtime"
import type { CommandRefusal } from "../core/member"
import type { PublicErrors } from "./socket"

/**
 * The two things the ACP v2 SDK cannot validate for us: the `_meta.aos`
 * payloads the shared contract defines, and the JSON-RPC error code a proxy
 * failure travels as. Every code comes from `AOS_JSONRPC_ERRORS`.
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
  return new RequestError(AOS_JSONRPC_ERRORS.invalidRequest, "invalid_request")
}

/** The guest lane's answer to anything it has not redeemed an invitation for. */
export function authenticationRequired() {
  return new RequestError(
    AOS_JSONRPC_ERRORS.authenticationRequired,
    "authentication_required"
  )
}

export function notFound() {
  return new RequestError(AOS_JSONRPC_ERRORS.notFound, "not_found")
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

const PUBLIC_ERROR_CODES: Readonly<
  Record<ServerRuntimePublicError["code"], number>
> = {
  runtime_authentication_required: AOS_JSONRPC_ERRORS.authenticationRequired,
  invalid_request: AOS_JSONRPC_ERRORS.invalidRequest,
  not_found: AOS_JSONRPC_ERRORS.notFound,
  revision_conflict: AOS_JSONRPC_ERRORS.revisionConflict,
  temporarily_unavailable: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
  connection_interrupted: AOS_JSONRPC_ERRORS.connectionInterrupted,
  uncertain_mutation: AOS_JSONRPC_ERRORS.uncertainMutation,
}

/** JSON-RPC's own code for a method the connection does not serve. */
const METHOD_NOT_FOUND = -32601

/** Every error code a public reply carries, with the name it travels as. */
const PUBLIC_ERROR_NAMES: ReadonlyMap<number, string> = new Map([
  [AOS_JSONRPC_ERRORS.authenticationRequired, "authentication_required"],
  [AOS_JSONRPC_ERRORS.turnInProgress, "turn_in_progress"],
  [AOS_JSONRPC_ERRORS.staleRequest, "stale_request"],
  [AOS_JSONRPC_ERRORS.notFound, "not_found"],
  [AOS_JSONRPC_ERRORS.revisionConflict, "revision_conflict"],
  [AOS_JSONRPC_ERRORS.temporarilyUnavailable, "temporarily_unavailable"],
  [AOS_JSONRPC_ERRORS.connectionInterrupted, "connection_interrupted"],
  [AOS_JSONRPC_ERRORS.uncertainMutation, "uncertain_mutation"],
  [AOS_JSONRPC_ERRORS.invalidRequest, "invalid_request"],
  [METHOD_NOT_FOUND, "method_not_found"],
])

/** Every code an `_aos/error` notification reports a failure with. */
const PUBLIC_NOTICE_CODES: ReadonlySet<string> = new Set([
  ...PUBLIC_ERROR_NAMES.values(),
  ...Object.keys(PUBLIC_ERROR_CODES),
  "internal_error",
])

/**
 * A failure as a public client may read it: a public code, and never the
 * detail a failure carries. Any other failure is reported temporarily
 * unavailable, as a reply and as a notification alike.
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
    PUBLIC_NOTICE_CODES.has(code) ? code : "temporarily_unavailable",
}

/** Coordinator control failures, mirroring the normalized HTTP error map. */
function coordinatorError(cause: unknown) {
  if (cause instanceof ServerTurnConflictError) return turnInProgress()
  if (cause instanceof ServerRequestStaleError) return staleRequest()
  if (
    cause instanceof ServerTurnCapacityError ||
    cause instanceof ServerTurnSteerUnavailableError
  )
    return temporarilyUnavailable()
  if (cause instanceof ServerTurnSteerUncertainError)
    return new RequestError(
      AOS_JSONRPC_ERRORS.uncertainMutation,
      "uncertain_mutation"
    )
  if (
    cause instanceof ServerTurnControlError ||
    cause instanceof ServerSessionNotFoundError
  )
    return notFound()
  return undefined
}

/** The JSON-RPC error a proxy failure travels as, or the failure itself. */
export function publicRequestError(runtime: ServerRuntime, cause: unknown) {
  const mapped = coordinatorError(cause)
  if (mapped) return mapped
  const publicError = runtime.publicError(cause)
  return publicError
    ? new RequestError(PUBLIC_ERROR_CODES[publicError.code], publicError.code)
    : cause
}

/**
 * The code and message an `_aos/error` notification reports a failure with.
 * The proxy has no operator-facing copy: a public failure travels as its
 * machine code, and the browser owns the localized sentence.
 */
export function errorNotificationOf(runtime: ServerRuntime, cause: unknown) {
  const mapped = publicRequestError(runtime, cause)
  return mapped instanceof RequestError
    ? { code: mapped.message, message: mapped.message }
    : { code: "internal_error", message: "internal_error" }
}
