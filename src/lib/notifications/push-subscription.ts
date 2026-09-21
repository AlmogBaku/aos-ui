import { z } from "zod"

import {
  PushRegistrationSchema,
  type PushInfo,
  type PushLocale,
  type PushRegistration,
} from "@aos/protocol/push"

import { OPEN_MESSAGE_TYPE } from "@aos/protocol/push"
import type { BrowserPermission, BrowserPreferences } from "./policy"

/**
 * This device's Web Push subscription: what the deployment offers, what the
 * browser granted, and what the proxy currently holds. While the proxy holds a
 * working subscription, push owns the OS alerts and no tab raises its own.
 */

export type PushStatus =
  "unsupported" | "insecure-context" | "not-configured" | "available"

/** The proxy REST surface push needs; the provider adapter implements it. */
export type PushClient = {
  pushInfo(): Promise<PushInfo>
  putPushSubscription(registration: PushRegistration): Promise<void>
  deletePushSubscription(endpoint: string): Promise<void>
}

export type PushSubscriptionLike = {
  endpoint: string
  toJSON(): unknown
  unsubscribe(): Promise<boolean>
}

/** Injected by the browser boundary; the manager never touches the DOM. */
export type PushPlatform = {
  secureContext: boolean
  supported: boolean
  register(): Promise<void>
  getSubscription(): Promise<PushSubscriptionLike | null>
  /** Null until a registration is ready; called straight from the gesture. */
  subscribe(applicationServerKey: string): Promise<PushSubscriptionLike> | null
  onMessage(listener: (data: unknown) => void): () => void
}

export type PushOpenTarget = { agentId: string; sessionId: string }

export type PushSyncInput = {
  permission: BrowserPermission
  preferences: BrowserPreferences
  locale: PushLocale
}

export type PushListeners = {
  onChange?(): void
  /** A notification click; without ids the workspace itself is the target. */
  onOpen?(target?: PushOpenTarget): void
}

export type PushSubscriptionManager = {
  status(): PushStatus
  active(): boolean
  prepare(permission: BrowserPermission): Promise<void>
  subscribeFromGesture(): Promise<BrowserPermission>
  sync(input: PushSyncInput): Promise<void>
  listen(listeners: PushListeners): () => void
  stop(): void
}

/** How long a browser that refused to subscribe is left alone. */
const SUBSCRIBE_RETRY_MS = 60_000

const openMessageSchema = z.object({
  type: z.string().max(64),
  agentId: z.string().min(1).max(512).optional(),
  sessionId: z.string().min(1).max(512).optional(),
})

function errorName(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : ""
}

export function createPushSubscriptionManager({
  client,
  platform,
  now = () => Date.now(),
}: {
  client: PushClient
  platform: PushPlatform
  now?: () => number
}): PushSubscriptionManager {
  let info: PushInfo | undefined
  let described: Promise<void> | undefined
  let registered: Promise<void> | undefined
  let subscription: PushSubscriptionLike | undefined
  /** Endpoint and body the proxy accepted; holding them is what makes push active. */
  let heldEndpoint: string | undefined
  let heldBody: string | undefined
  /** When subscribing last failed, so a sync per arrival cannot become a storm. */
  let refusedAt: number | undefined
  const listeners = new Set<PushListeners>()
  let bridge: (() => void) | undefined

  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener.onChange?.()
      } catch {
        /* A failing observer never stops the subscription. */
      }
    }
  }
  const status = (): PushStatus =>
    !platform.supported
      ? "unsupported"
      : !platform.secureContext
        ? "insecure-context"
        : info?.status === "available"
          ? "available"
          : "not-configured"
  const release = () => {
    heldEndpoint = undefined
    heldBody = undefined
  }
  const retire = async (endpoint: string | undefined) => {
    if (endpoint) await client.deletePushSubscription(endpoint)
  }
  /**
   * Permission can be granted without the ask ever appearing — re-allowed from
   * the padlock, cleared site data, another profile that allowed AOS before — so
   * an enabled device with nothing subscribed subscribes here. A gesture is only
   * needed to raise the prompt, which this path never does.
   */
  const subscribeHere = async () => {
    const key = info?.status === "available" ? info.publicKey : undefined
    if (!key) return undefined
    if (refusedAt !== undefined && now() - refusedAt < SUBSCRIBE_RETRY_MS)
      return undefined
    try {
      // One attempt per sync; a browser that refuses is left alone for a while.
      const next = await platform.subscribe(key)
      if (!next) throw new Error("No push registration is ready")
      refusedAt = undefined
      subscription = next
      return next
    } catch {
      refusedAt = now()
      return undefined
    }
  }

  return {
    status,
    active: () =>
      subscription !== undefined && heldEndpoint === subscription.endpoint,
    async prepare(permission) {
      if (!platform.supported || !platform.secureContext) return
      // An undescribed deployment is simply one without push.
      described ??= (async () => {
        try {
          info = await client.pushInfo()
        } catch {
          info = { status: "not-configured" }
        }
        changed()
      })()
      await described
      if (status() !== "available" || permission === "denied") return
      registered ??= (async () => {
        try {
          await platform.register()
        } catch {
          /* Delivery stays tab-local when the worker cannot be installed. */
        }
      })()
      await registered
      changed()
    },
    subscribeFromGesture() {
      const key = info?.status === "available" ? info.publicKey : undefined
      // Safari raises its prompt from this call, so nothing may await first.
      const pending = key ? platform.subscribe(key) : null
      if (!pending) return Promise.resolve("default")
      return pending.then(
        (granted): BrowserPermission => {
          subscription = granted
          changed()
          return "granted"
        },
        (error: unknown): BrowserPermission =>
          errorName(error) === "NotAllowedError" ? "denied" : "default"
      )
    },
    async sync({ permission, preferences, locale }) {
      if (status() !== "available") return
      try {
        const current = await platform.getSubscription()
        subscription = current ?? undefined
        if (!preferences.enabled || permission !== "granted") {
          if (current) await current.unsubscribe()
          const stale = current?.endpoint ?? heldEndpoint
          subscription = undefined
          release()
          await retire(stale)
          changed()
          return
        }
        let live: PushSubscriptionLike | undefined = current ?? undefined
        if (!live) {
          // Whatever the proxy held belonged to a subscription this browser no
          // longer has, so it is retired before a fresh one replaces it.
          const stale = heldEndpoint
          release()
          await retire(stale)
          live = await subscribeHere()
          if (!live) {
            changed()
            return
          }
        }
        const registration = PushRegistrationSchema.safeParse({
          subscription: live.toJSON(),
          locale,
          categories: {
            input: preferences.input,
            failure: preferences.failure,
            completion: preferences.completion,
          },
        })
        if (!registration.success) throw new Error("Invalid push registration")
        const body = JSON.stringify(registration.data)
        // The browser may replace an endpoint at any time; the old one is then
        // a subscription the proxy would keep pushing to.
        const rotated =
          heldEndpoint && heldEndpoint !== live.endpoint
            ? heldEndpoint
            : undefined
        if (body !== heldBody || heldEndpoint !== live.endpoint) {
          await client.putPushSubscription(registration.data)
          heldEndpoint = live.endpoint
          heldBody = body
        }
        await retire(rotated)
        changed()
      } catch {
        // The proxy does not hold this device, so its tabs keep alerting.
        release()
        changed()
      }
    },
    listen(listener) {
      listeners.add(listener)
      bridge ??= platform.onMessage((data) => {
        const message = openMessageSchema.safeParse(data)
        if (!message.success || message.data.type !== OPEN_MESSAGE_TYPE) return
        const { agentId, sessionId } = message.data
        const target = agentId && sessionId ? { agentId, sessionId } : undefined
        for (const observer of [...listeners]) {
          try {
            observer.onOpen?.(target)
          } catch {
            /* A failing observer never stops the subscription. */
          }
        }
      })
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          bridge?.()
          bridge = undefined
        }
      }
    },
    stop() {
      listeners.clear()
      bridge?.()
      bridge = undefined
    },
  }
}

/** VAPID keys travel as base64url text and subscribe wants the bytes. */
export function decodeApplicationServerKey(key: string) {
  const base64 = key.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(
    base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
  )
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function createBrowserPushPlatform(): PushPlatform {
  let ready: ServiceWorkerRegistration | undefined
  return {
    get secureContext() {
      return typeof window !== "undefined" && window.isSecureContext
    },
    get supported() {
      return (
        typeof navigator !== "undefined" &&
        typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window
      )
    },
    async register() {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" })
      ready = await navigator.serviceWorker.ready
    },
    async getSubscription() {
      const registration =
        ready ?? (await navigator.serviceWorker?.getRegistration())
      return (await registration?.pushManager.getSubscription()) ?? null
    },
    subscribe(applicationServerKey) {
      if (!ready) return null
      return ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(applicationServerKey),
      })
    },
    onMessage(listener) {
      // A browser without a worker container has nothing to bridge.
      const workers =
        typeof navigator === "undefined" ? undefined : navigator.serviceWorker
      if (!workers) return () => {}
      const receive = (event: MessageEvent) => listener(event.data)
      workers.addEventListener("message", receive)
      return () => workers.removeEventListener("message", receive)
    },
  }
}
