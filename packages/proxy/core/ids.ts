/** The public Session id: what the browser names a Session by on the wire. */
export type SessionId = string & { readonly __brand: "SessionId" }

/** The provider's own id for a Session; it never leaves the proxy. */
export type ProviderSessionId = string & {
  readonly __brand: "ProviderSessionId"
}

/**
 * The only mint point for a `SessionId`: call it where a Session scope is
 * built from a wire string.
 */
export function sessionId(value: string): SessionId {
  return value as SessionId
}

/**
 * The only mint point for a `ProviderSessionId`: call it in an adapter's
 * resolver and where a Session scope is built from a provider's id.
 */
export function providerSessionId(value: string): ProviderSessionId {
  return value as ProviderSessionId
}
