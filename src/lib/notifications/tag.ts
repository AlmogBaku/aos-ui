import { activityScope } from "./activity"

/** Only a hash of opaque identity appears on the OS surface. */
export function notificationTag(
  agentId: string,
  sessionId: string,
  id: string
) {
  let hash = 2166136261
  for (const char of activityScope({ agentId, sessionId }, id))
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `aos-ui-${(hash >>> 0).toString(16)}`
}
