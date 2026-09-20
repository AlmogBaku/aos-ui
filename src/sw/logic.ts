import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { buildWorkspacePathname } from "@/lib/workspace-routing"
import {
  PushMessageSchema,
  type PushCategory,
  type PushMessage,
} from "@aos/protocol/push"

/**
 * Push handling for the service worker, kept free of worker globals so the
 * notification a device is shown can be asserted directly. A push that cannot
 * be read still owes exactly one notification: swallowing it revokes the
 * subscription on Safari and shows a browser-authored notice on Chrome.
 */

/** `NotificationOptions` plus `timestamp`, which the DOM types omit. */
export type PushNotificationOptions = {
  body: string
  tag: string
  icon: string
  timestamp?: number
  requireInteraction?: boolean
  data?: PushMessage
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
  postMessage(message: unknown): void
}

type ClientsSurface = {
  matchAll(options: {
    type: "window"
    includeUncontrolled: boolean
  }): Promise<readonly WindowClientSurface[]>
  openWindow(url: string): Promise<unknown>
}

/** A focused tab opens the Session itself rather than being navigated. */
export const OPEN_MESSAGE_TYPE = "aos:open"

const TITLE = en.productName
const ICON = "/icons/pwa-192x192.png"
/** Tag of the notification an unreadable payload owes. */
const GENERIC_TAG = "aos"

const bodyKeys = {
  input: { one: "inputRequested", many: "inputRequestedMany" },
  failure: { one: "runFailed", many: "runFailedMany" },
  completion: { one: "runFinished", many: "runFinishedMany" },
} as const satisfies Record<PushCategory, { one: string; many: string }>

const dictionaries = { en, he }

function readMessage(value: unknown): PushMessage | undefined {
  const parsed = PushMessageSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function readPayload(payload: string | undefined): PushMessage | undefined {
  if (payload === undefined) return undefined
  try {
    return readMessage(JSON.parse(payload))
  } catch {
    return undefined
  }
}

function bodyOf({ category, count, locale }: PushMessage): string {
  const { activity } = dictionaries[locale]
  const keys = bodyKeys[category]
  return count === 1
    ? activity[keys.one]
    : activity[keys.many].replace("{count}", String(count))
}

function optionsOf(message: PushMessage | undefined): PushNotificationOptions {
  if (!message) {
    return { body: en.activity.pushGeneric, tag: GENERIC_TAG, icon: ICON }
  }
  return {
    body: bodyOf(message),
    tag: message.category,
    icon: ICON,
    timestamp: Date.parse(message.occurredAt),
    // Input requests outlive the OS auto-dismissal; outcomes do not.
    requireInteraction: message.category === "input",
    data: message,
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

/** Replaces the category's predecessor with exactly one notification. */
export async function handlePush(
  registration: NotificationSurface,
  payload: string | undefined
): Promise<void> {
  const options = optionsOf(readPayload(payload))
  await closeSameTag(registration, options.tag)
  await registration.showNotification(TITLE, options)
}

/** Focuses an open tab when there is one, else opens the deep link. */
export async function handleNotificationClick(
  clients: ClientsSurface,
  notification: ClickedNotification
): Promise<void> {
  notification.close()
  const message = readMessage(notification.data)
  const [client] = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  })
  if (client) {
    await client.focus()
    client.postMessage({
      type: OPEN_MESSAGE_TYPE,
      ...(message?.agentId ? { agentId: message.agentId } : {}),
      ...(message?.sessionId ? { sessionId: message.sessionId } : {}),
    })
    return
  }
  await clients.openWindow(
    buildWorkspacePathname({
      agentId: message?.agentId ?? null,
      sessionId: message?.sessionId ?? null,
    })
  )
}
