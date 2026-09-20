import { categoryOf } from "@aos/protocol/push"

import type { WorkspaceActivityEvent } from "@/runtime-adapters/contracts"

/** Whether the operator has answered the one-time ask for OS notifications. */
export type BrowserAskState = "pending" | "accepted" | "declined"

export type BrowserPreferences = {
  enabled: boolean
  completion: boolean
  failure: boolean
  input: boolean
  sound: boolean
  prompt: BrowserAskState
}

export type ActivityContext = {
  selection: { agentId: string; threadId: string } | null
  pageVisible: boolean
  pageFocused: boolean
  /** False while a modal surface prevents the user from seeing the selection. */
  conversationExposed?: boolean
  /** True while this device receives Web Push, which owns its OS alerts. */
  pushActive?: boolean
}

export type BrowserPermission = "default" | "granted" | "denied" | "unsupported"

export const defaultBrowserPreferences: Readonly<BrowserPreferences> = {
  enabled: true,
  completion: true,
  failure: true,
  input: true,
  sound: true,
  prompt: "pending",
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

type ActivityPolicyEvent = WorkspaceActivityEvent & {
  read?: boolean
  resolved?: boolean
  browserDeliveredAt?: string | null
}

export function getActivityPolicy(
  event: ActivityPolicyEvent,
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
  const category = categoryOf(event.type)
  return {
    markRead,
    inAppNotice: eligible && foreground && !markRead,
    browserNotification:
      eligible &&
      !foreground &&
      !context.pushActive &&
      !event.browserDeliveredAt &&
      preferences.enabled &&
      category !== undefined &&
      preferences[category] &&
      permission === "granted",
  }
}

/** A chime belongs to a visible notice the operator has to act on. */
export function shouldChime(
  event: ActivityPolicyEvent,
  context: ActivityContext,
  preferences: BrowserPreferences
) {
  const category = categoryOf(event.type)
  return (
    (category === "input" || category === "failure") &&
    preferences.sound &&
    // The chime accompanies the in-app notice, so OS permission never gates it.
    getActivityPolicy(event, context, preferences, "unsupported").inAppNotice
  )
}

/**
 * The ask waits for a run the operator watched, and is offered exactly once.
 * An uninstalled iOS tab has no notification API to ask at all, so the ask is
 * what tells it to install AOS first.
 */
export function shouldOfferAsk(
  permission: BrowserPermission,
  preferences: BrowserPreferences,
  firstRunSeen: boolean,
  installFirst = false
) {
  return (
    (permission === "default" ||
      (permission === "unsupported" && installFirst)) &&
    preferences.enabled &&
    preferences.prompt === "pending" &&
    firstRunSeen
  )
}
