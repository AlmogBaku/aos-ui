import { en } from "@/lib/i18n/dictionaries/en"
import { formatNotification } from "@/lib/notifications/format"
import { sessionTag } from "@/lib/notifications/tag"
import { buildWorkspacePathname } from "@/lib/workspace-routing"
import type { OPEN_MESSAGE_TYPE as PROTOCOL_OPEN_MESSAGE_TYPE } from "@/sw/open-messages"
import type {
  PUSH_TEXT_LIMITS as PROTOCOL_PUSH_TEXT_LIMITS,
  PushCategory,
  PushLocale,
  PushMessage,
} from "@harness-gw/sdk/protocol"

// Literals typed against the protocol's constants: the worker must not import
// the protocol module at runtime (it would pull zod into the bundle).
const OPEN_MESSAGE_TYPE: typeof PROTOCOL_OPEN_MESSAGE_TYPE = "aos:open"
const PUSH_TEXT_LIMITS: typeof PROTOCOL_PUSH_TEXT_LIMITS = {
  agentName: 64,
  sessionTitle: 120,
  requestText: 200,
}

/**
 * Push handling for the service worker, kept free of worker globals so the
 * notification a device is shown can be asserted directly. A push that cannot
 * be read still owes exactly one notification: swallowing it revokes the
 * subscription on Safari and shows a browser-authored notice on Chrome.
 *
 * Payloads are read by hand rather than with `PushMessageSchema`, because a
 * worker woken by every push should not pay for the validator: importing it
 * pulled the whole zod runtime into this bundle. `readMessage` mirrors that
 * schema and must change with it.
 */

/** All a click needs, and all the OS surface keeps: never a name or a text. */
export type PushNotificationData = Pick<
  PushMessage,
  "category" | "agentId" | "sessionId"
>

/** `NotificationOptions` plus `timestamp`, which the DOM types omit. */
export type PushNotificationOptions = {
  body: string
  tag: string
  icon: string
  timestamp?: number
  requireInteraction?: boolean
  data?: PushNotificationData
}

type ClosableNotification = { close(): void }

type NotificationSurface = {
  getNotifications(filter: {
    tag: string
  }): Promise<readonly ClosableNotification[]>
  showNotification(
    title: string,
    options: PushNotificationOptions
  ): Promise<void>
}

type ClickedNotification = ClosableNotification & { data: unknown }

type WindowClientSurface = {
  focus(): Promise<unknown>
  postMessage(message: unknown, transfer?: readonly unknown[]): void
  /** Optional so a browser reporting neither still yields a usable tab. */
  focused?: boolean
  visibilityState?: string
}

/** What a window must answer on before the click counts as delivered. */
export type ClickAcknowledgement = {
  port: unknown
  answered: Promise<boolean>
}

type ClientsSurface = {
  matchAll(options: {
    type: "window"
    includeUncontrolled: boolean
  }): Promise<readonly WindowClientSurface[]>
  openWindow(url: string): Promise<unknown>
}

const TITLE = en.productName
const ICON = "/icons/pwa-192x192.png"
/** Tag of the notification an unreadable payload owes. */
const GENERIC_TAG = "aos"
/** Where a click lands when it names no Session, and the last resort. */
const WORKSPACE_ROOT = buildWorkspacePathname({
  agentId: null,
  sessionId: null,
})

const categories = {
  input: true,
  failure: true,
  completion: true,
} satisfies Record<PushCategory, true>

const locales = { en: true, he: true } satisfies Record<PushLocale, true>

/** Both key sets are exhaustive above, so membership is the value check. */
function isCategory(value: unknown): value is PushCategory {
  return typeof value === "string" && Object.hasOwn(categories, value)
}

function isLocale(value: unknown): value is PushLocale {
  return typeof value === "string" && Object.hasOwn(locales, value)
}

/** Mirrors the protocol's `IdentifierSchema`: 1-256 printable characters. */
function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

/** A text field within the protocol's bound, or nothing. */
function fitted(value: unknown, field: keyof typeof PUSH_TEXT_LIMITS) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= PUSH_TEXT_LIMITS[field]
    ? value
    : undefined
}

/**
 * Exported so `logic.parity.test.ts` can hold it against the schema. Unlike
 * the schema, it ignores a key it does not know and drops a malformed label,
 * so a newer gateway or one bad field still yields this Session's notification.
 */
export function readMessage(value: unknown): PushMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const fields = value as Record<string, unknown>
  const { v, category, occurredAt, locale, agentId, sessionId } = fields
  if (v !== 2) return undefined
  if (!isCategory(category) || !isLocale(locale)) return undefined
  // Looser than the schema's ISO 8601: a readable date is all a timestamp needs.
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    return undefined
  }
  if (!isIdentifier(agentId) || !isIdentifier(sessionId)) return undefined
  const agentName = fitted(fields.agentName, "agentName")
  const sessionTitle = fitted(fields.sessionTitle, "sessionTitle")
  const requestText = fitted(fields.requestText, "requestText")
  const { requestMore } = fields
  return {
    v,
    category,
    agentId,
    sessionId,
    occurredAt,
    locale,
    ...(agentName ? { agentName } : {}),
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(requestText ? { requestText } : {}),
    ...(typeof requestMore === "number" &&
    Number.isInteger(requestMore) &&
    requestMore >= 1
      ? { requestMore }
      : {}),
  }
}

function readPayload(payload: string | undefined): PushMessage | undefined {
  if (payload === undefined) return undefined
  try {
    return readMessage(JSON.parse(payload))
  } catch {
    return undefined
  }
}

function notificationOf(message: PushMessage | undefined): {
  title: string
  options: PushNotificationOptions
} {
  if (!message) {
    return {
      title: TITLE,
      options: { body: en.activity.pushGeneric, tag: GENERIC_TAG, icon: ICON },
    }
  }
  const { category, agentId, sessionId } = message
  const { title, body } = formatNotification(message)
  return {
    title,
    options: {
      body,
      tag: sessionTag(agentId, sessionId),
      icon: ICON,
      timestamp: Date.parse(message.occurredAt),
      // Input requests outlive the OS auto-dismissal; outcomes do not.
      requireInteraction: category === "input",
      data: { category, agentId, sessionId },
    },
  }
}

async function closeSameTag(registration: NotificationSurface, tag: string) {
  try {
    for (const notification of await registration.getNotifications({ tag })) {
      notification.close()
    }
  } catch {
    // A browser that cannot enumerate notifications still owes exactly one.
  }
}

/** Attempts exactly one notification, replacing the Session's predecessor. */
export async function handlePush(
  registration: NotificationSurface,
  payload: string | undefined
): Promise<void> {
  const { title, options } = notificationOf(readPayload(payload))
  await closeSameTag(registration, options.tag)
  try {
    await registration.showNotification(title, options)
  } catch {
    // Permission can be revoked between subscribing and this push, and the
    // display then throws. Nothing here can answer that: the worker has no
    // surface left and no open client to tell. The app reconciles on its next
    // focus by unsubscribing and deleting the server registration.
  }
}

type ClickTarget = { agentId: string; sessionId: string }

/** The Session a notification's data names; anything else opens the workspace. */
function readTarget(data: unknown): ClickTarget | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const { agentId, sessionId } = data as Record<string, unknown>
  return isIdentifier(agentId) && isIdentifier(sessionId)
    ? { agentId, sessionId }
    : undefined
}

/** The tab the operator is looking at, else one that is at least on screen. */
function bestTab(
  tabs: readonly WindowClientSurface[]
): WindowClientSurface | undefined {
  return (
    tabs.find((tab) => tab.focused === true) ??
    tabs.find((tab) => tab.visibilityState === "visible") ??
    tabs[0]
  )
}

/** Windows that cannot be listed are no windows: the click still owes one. */
async function listTabs(clients: ClientsSurface) {
  try {
    return await clients.matchAll({ type: "window", includeUncontrolled: true })
  } catch {
    return []
  }
}

/**
 * Hands the Session to an open tab, which validates provider ownership before
 * selecting it, and answers whether that tab took the click.
 *
 * Existing is not the same as running: a browser reports windows it restored
 * but has not loaded, frozen and discarded documents, and tabs still starting
 * the app, and a message posted to any of those reaches no listener. Only the
 * tab's own answer settles it — as a refused focus, on a tab that is already
 * closing, settles it the other way.
 */
async function askOpenTab(
  tab: WindowClientSurface | undefined,
  target: ClickTarget | undefined,
  acknowledge: () => ClickAcknowledgement
): Promise<boolean> {
  if (!tab) return false
  try {
    await tab.focus()
    const { port, answered } = acknowledge()
    tab.postMessage({ type: OPEN_MESSAGE_TYPE, ...target }, [port])
    return await answered
  } catch {
    return false
  }
}

/** Opens the deep link, falling back to the workspace root it already is. */
async function openWindow(
  clients: ClientsSurface,
  target: string
): Promise<boolean> {
  const attempts =
    target === WORKSPACE_ROOT ? [target] : [target, WORKSPACE_ROOT]
  for (const url of attempts) {
    try {
      await clients.openWindow(url)
      return true
    } catch {
      // A root that will not open leaves nothing further to try.
    }
  }
  return false
}

/**
 * The click path has no page to report to and no step allowed to throw, so this
 * one line is all that separates a focused window from an opened one — or from a
 * click that produced neither — in `chrome://serviceworker-internals`. Branch
 * and counts only: a notification names a Session, and logs stay content-free.
 */
function trace(branch: "focused" | "opened" | "nothing", tabs: number) {
  console.info(`aos push click: ${branch}, windows=${tabs}`)
}

/**
 * Hands the click to an open tab when one takes it, and otherwise opens a
 * window. A click the operator makes must always end with a visible window, so
 * no step here is allowed to reject its way out of the handler.
 */
export async function handleNotificationClick(
  clients: ClientsSurface,
  notification: ClickedNotification,
  acknowledge: () => ClickAcknowledgement
): Promise<void> {
  try {
    notification.close()
  } catch {
    // A notification that will not dismiss still owes the operator a window.
  }
  const target = readTarget(notification.data)
  const tabs = await listTabs(clients)
  if (await askOpenTab(bestTab(tabs), target, acknowledge)) {
    trace("focused", tabs.length)
    return
  }
  const opened = await openWindow(
    clients,
    buildWorkspacePathname({
      agentId: target?.agentId ?? null,
      sessionId: target?.sessionId ?? null,
    })
  )
  trace(opened ? "opened" : "nothing", tabs.length)
}
