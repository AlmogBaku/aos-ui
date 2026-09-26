/**
 * The single trusted principal every operator connection belongs to. It keys
 * the per-operator state the proxy holds outside one connection — workspace
 * presence, push subscriptions — so the name is stated once rather than
 * inferred from a role.
 */
export const OPERATOR_PRINCIPAL = "operator"

/** Every guest principal is this prefix and the invitation's token id. */
export const GUEST_PRINCIPAL_PREFIX = "guest:"
