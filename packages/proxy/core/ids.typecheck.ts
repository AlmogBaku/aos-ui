/**
 * Compile-time proof that the two Session ids do not mix. `tsconfig.proxy.json`
 * typechecks this file; nothing imports or runs it.
 */
import * as ids from "./ids"

// @ts-expect-error A provider's id is not a public Session id.
export const providerAsPublic: ids.SessionId = ids.providerSessionId("p-1")

// @ts-expect-error A public Session id is not a provider's id.
export const publicAsProvider: ids.ProviderSessionId = ids.sessionId("s-1")

// @ts-expect-error A plain string is no Session id until it is minted.
export const plainAsPublic: ids.SessionId = "s-1"
