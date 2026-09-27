/**
 * The native key an invited Session is found by. An invitation's `ref` names
 * one conversation per Agent, so a runtime that finds Sessions by title titles
 * the invited one with this key, and OpenClaw, which keys a Session by Agent,
 * scopes it under the Agent. Each adapter validates `ref` before building one.
 */
export function inviteSessionKey(ref: string) {
  return `aos-invite:${ref}`
}

/** OpenClaw's Session key for an invited conversation with `agentId`. */
export function openClawInviteSessionKey(agentId: string, ref: string) {
  return `agent:${agentId}:${inviteSessionKey(ref)}`
}
