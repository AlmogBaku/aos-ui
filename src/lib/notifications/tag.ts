/**
 * One OS notification per Session: its tag replaces that Session's previous
 * one. Only a hash of the opaque ids appears on the OS surface. The service
 * worker imports this, so it imports nothing.
 */
export function sessionTag(agentId: string, sessionId: string) {
  let hash = 2166136261
  for (const char of JSON.stringify([agentId, sessionId]))
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `aos-ui-${(hash >>> 0).toString(16)}`
}
