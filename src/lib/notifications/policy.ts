import type { WorkspaceActivityEvent } from "@/runtime-adapters/contracts"

export type BrowserPreferences = {
  enabled: boolean
  completion: boolean
  failure: boolean
  input: boolean
}

export type ActivityContext = {
  selection: { agentId: string; threadId: string } | null
  pageVisible: boolean
  pageFocused: boolean
  /** False while a modal surface prevents the user from seeing the selection. */
  conversationExposed?: boolean
}

export type BrowserPermission = "default" | "granted" | "denied" | "unsupported"

export const defaultBrowserPreferences: Readonly<BrowserPreferences> = {
  enabled: false,
  completion: true,
  failure: true,
  input: true,
}

/** True while the operator can actually see the selected conversation. */
export function isSelectionExposed(context: ActivityContext) {
  return (
    context.pageVisible &&
    context.pageFocused &&
    context.conversationExposed !== false &&
    context.selection !== null
  )
}

export function getActivityPolicy(
  event: WorkspaceActivityEvent & {
    read?: boolean
    resolved?: boolean
    browserDeliveredAt?: string | null
  },
  context: ActivityContext,
  preferences: BrowserPreferences,
  permission: BrowserPermission
) {
  if (event.type === "run-started" || event.type === "attention-resolved") {
    return { markRead: false, inAppNotice: false, browserNotification: false }
  }
  const foreground = context.pageVisible && context.pageFocused
  const markRead =
    isSelectionExposed(context) &&
    context.selection?.agentId === event.agentId &&
    context.selection?.threadId === event.threadId
  const eligible = !event.read && !event.resolved
  const category =
    event.type === "attention-requested"
      ? "input"
      : event.type === "run-failed" || event.type === "agent-activation-failed"
        ? "failure"
        : "completion"
  return {
    markRead,
    inAppNotice: eligible && foreground && !markRead,
    browserNotification:
      eligible &&
      !foreground &&
      !event.browserDeliveredAt &&
      preferences.enabled &&
      preferences[category] &&
      permission === "granted",
  }
}
