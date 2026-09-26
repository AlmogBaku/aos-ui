import type { Middleware } from "../../core/member"
import { GUEST_PRINCIPAL_PREFIX } from "../../core/principal"

/**
 * Every guest's turns share one cap, whichever invitation started them: a
 * guest's send is counted against the turns every guest holds, beside the
 * deployment's own limit.
 */
export function createQuotaMiddleware({
  limit,
}: {
  limit: number
}): Middleware {
  const quota = {
    predicate: (principalId: string) =>
      principalId.startsWith(GUEST_PRINCIPAL_PREFIX),
    limit,
  }
  return {
    commands: {
      send: (command, next) => next({ ...command, quota }),
    },
  }
}
