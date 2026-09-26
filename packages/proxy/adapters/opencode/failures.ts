import { failureOf, type PublicFailure } from "../../core/failures"
import {
  OpenCodeClientAbortError,
  OpenCodeClientError,
  OpenCodeMutationUncertainError,
} from "./client"
import {
  OpenCodeContentUnavailableError,
  OpenCodeContentUnreadableError,
} from "./content"
import { OpenCodeInteractionPublicError } from "./interactions"
import {
  OpenCodeWorkspaceScopeError,
  OpenCodeWorkspaceUnavailableError,
} from "./workspace"

/** The failure an error this adapter raises is, by its kind. */
export function openCodeFailure(cause: unknown): PublicFailure | undefined {
  if (cause instanceof OpenCodeMutationUncertainError)
    return failureOf("uncertain", cause)
  // A lost stream is a read: a write that may have landed is already a
  // mutation-uncertain error.
  if (cause instanceof OpenCodeClientAbortError)
    return failureOf("unavailable", cause)
  if (cause instanceof OpenCodeClientError) {
    if (cause.code === "authentication")
      return failureOf("runtime_authentication_required", cause)
    if (cause.code === "invalid_request")
      return failureOf("invalid_request", cause)
    if (cause.code === "not_found") return failureOf("gone", cause)
    if (cause.code === "conflict") return failureOf("revision_conflict", cause)
    return failureOf("unavailable", cause)
  }
  if (
    cause instanceof OpenCodeWorkspaceScopeError ||
    // The receipt is still authoritative, but OpenCode cannot read its file:
    // unlike a 503, "not found" never invites a retry that cannot succeed.
    cause instanceof OpenCodeContentUnreadableError
  )
    return failureOf("gone", cause)
  if (cause instanceof OpenCodeWorkspaceUnavailableError)
    return failureOf("unavailable", cause)
  if (cause instanceof OpenCodeContentUnavailableError)
    return failureOf("unavailable", cause)
  if (cause instanceof OpenCodeInteractionPublicError) {
    if (cause.code === "AOS_INTERACTION_NOT_FOUND")
      return failureOf("gone", cause)
    if (cause.code === "AOS_MUTATION_UNCERTAIN")
      return failureOf("uncertain", cause)
    if (
      cause.code === "AOS_PROVIDER_UNAVAILABLE" ||
      cause.code === "AOS_PROVIDER_INVALID_RESPONSE"
    )
      return failureOf("unavailable", cause)
    return failureOf("invalid_request", cause)
  }
  return undefined
}
