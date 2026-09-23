import { z } from "zod"
import { categoryOf } from "@aos/protocol/push"
import type { ActivityRecord } from "./activity"
import type { ActivityStore } from "./store"
import type { BrowserNotificationPort } from "./browser-port"
import {
  defaultBrowserPreferences,
  getActivityPolicy,
  isSelectionExposed,
  shouldOfferAsk,
  type ActivityContext,
  type BrowserPermission,
  type BrowserPreferences,
} from "./policy"
import { deserializeActivity, serializeActivity } from "./serialization"
import { notificationTag } from "./tag"

export interface ActivityBrowserPlatform {
  read(): string | null
  write(value: string): void
  send(value: unknown): void
  subscribe(listener: (value: unknown) => void): () => void
  startLeadership(onLeader?: () => void): () => void
  isLeader(): boolean
  settleDelivery(callback: () => void): () => void
  focus(): void
}
export type BrowserActivityOptions = {
  store: ActivityStore
  port: BrowserNotificationPort
  platform: ActivityBrowserPlatform
  context(): ActivityContext
  copy(): { completion: string; failure: string; input: string }
  now(): number
  open(id: string): Promise<boolean>
  onChange(): void
  /** Present once this device can receive Web Push, which then owns OS alerts. */
  push?: {
    active(): boolean
    subscribeFromGesture?(): Promise<BrowserPermission>
  }
  /** True where notifications need the app installed before they exist at all. */
  installFirst?: () => boolean
}
const messageSchema = z
  .object({
    snapshot: z.string().max(1_000_000),
    liveId: z.string().max(512).optional(),
    /** Announces an OS alert a peer already raised, so no tab repeats it. */
    deliveredId: z.string().max(512).optional(),
    preferencesChanged: z.boolean(),
  })
  .strict()

/** Live arrivals are explicit; hydration and leadership changes never replay OS alerts. */
export class BrowserActivityCoordinator {
  readonly #options: BrowserActivityOptions
  #preferences: BrowserPreferences = { ...defaultBrowserPreferences }
  #permission: BrowserPermission = "unsupported"
  #active = false
  #firstRunSeen = false
  #generation = 0
  #cleanup: (() => void)[] = []
  #notifications = new Set<{ close(): void }>()
  #pending = new Set<string>()
  #settling = false
  #cancelSettlement: (() => void) | undefined
  constructor(options: BrowserActivityOptions) {
    this.#options = options
  }
  start() {
    this.#active = true
    try {
      const saved = this.#options.platform.read()
      const snapshot = saved && deserializeActivity(saved)
      if (snapshot) this.#preferences = snapshot.preferences
    } catch {
      /* Storage may be blocked; preferences fall back to the defaults. */
    }
    this.recheckPermission()
    try {
      // A permission revoked or reset from the browser's own settings has to be
      // noticed here, not at the next focus: until it is, this device holds a
      // subscription the proxy would keep pushing into nothing.
      const stop = this.#options.port.onPermissionChange?.(() => {
        if (this.#active) this.recheckPermission()
      })
      if (stop) this.#cleanup.push(stop)
    } catch {
      /* Without the capability the recheck stays focus-driven. */
    }
    try {
      this.#cleanup.push(
        this.#options.platform.startLeadership(() => {
          this.#scheduleDelivery()
        })
      )
    } catch {
      /* Fail closed for delivery. */
    }
    try {
      this.#cleanup.push(
        this.#options.platform.subscribe((value) => this.#receive(value))
      )
    } catch {
      /* Local Activity still works. */
    }
  }
  stop() {
    this.#active = false
    this.#generation++
    for (const cleanup of this.#cleanup.splice(0)) {
      try {
        cleanup()
      } catch {}
    }
    for (const notification of this.#notifications) {
      try {
        notification.close()
      } catch {}
    }
    this.#notifications.clear()
    this.#pending.clear()
    this.#cancelSettlement?.()
    this.#cancelSettlement = undefined
    this.#settling = false
  }
  settings() {
    return {
      status: this.#permission,
      preferences: { ...this.#preferences },
      ask: shouldOfferAsk(
        this.#permission,
        this.#preferences,
        this.#firstRunSeen,
        this.#installFirst()
      ),
      pushActive: this.#pushActive(),
    }
  }
  /** The ask waits for a run the operator watched in this tab. */
  noteTurnStarted(event: { agentId: string; threadId: string }) {
    if (!this.#active || this.#firstRunSeen) return
    const context = this.#options.context()
    if (
      !isSelectionExposed(context) ||
      context.selection?.agentId !== event.agentId ||
      context.selection?.threadId !== event.threadId
    )
      return
    this.#firstRunSeen = true
    this.#options.onChange()
  }
  recheckPermission() {
    try {
      this.#permission = this.#options.port.getPermission()
    } catch {
      this.#permission = "unsupported"
    }
    this.#options.onChange()
  }
  /** Call directly from the checkbox event, before any await/effect scheduling. */
  async setEnabled(enabled: boolean) {
    const generation = ++this.#generation
    this.recheckPermission()
    if (!enabled) {
      this.#preferences.enabled = false
      this.publish(undefined, true)
      return
    }
    try {
      if (this.#permission === "default") {
        const requested = this.#options.port.requestPermission()
        const permission = await requested
        if (!this.#active || generation !== this.#generation) return
        this.#permission = permission
      }
      this.#preferences.enabled = this.#permission === "granted"
    } catch {
      this.#preferences.enabled = false
      this.recheckPermission()
    }
    if (this.#active && generation === this.#generation)
      this.publish(undefined, true)
  }
  /** Call directly from the click event, before any await/effect scheduling. */
  async acceptAsk() {
    const generation = ++this.#generation
    const { port, push } = this.#options
    // Safari raises its permission prompt from the subscribe call itself.
    const subscribed = push?.subscribeFromGesture?.()
    const requested = subscribed ?? port.requestPermission()
    try {
      const answer = await requested
      if (!this.#active || generation !== this.#generation) return
      // Subscribing answers "default" while no registration is ready yet, and
      // the OS prompt then still belongs to this gesture.
      const permission =
        subscribed && answer === "default"
          ? await port.requestPermission()
          : answer
      if (!this.#active || generation !== this.#generation) return
      this.#permission = permission
      // A refusal is the browser's answer, so the ask itself stays unanswered.
      this.#preferences.enabled = permission === "granted"
      if (permission === "granted") this.#preferences.prompt = "accepted"
    } catch {
      this.#preferences.enabled = false
      this.recheckPermission()
    }
    if (this.#active && generation === this.#generation)
      this.publish(undefined, true)
  }
  declineAsk() {
    this.#generation++
    this.#preferences.prompt = "declined"
    this.#preferences.enabled = false
    this.publish(undefined, true)
  }
  setCategory(category: "completion" | "failure" | "input", enabled: boolean) {
    this.#preferences[category] = enabled
    this.publish(undefined, true)
  }
  setSound(enabled: boolean) {
    this.#preferences.sound = enabled
    this.publish(undefined, true)
  }
  #pushActive() {
    try {
      return this.#options.push?.active() ?? false
    } catch {
      return false
    }
  }
  #installFirst() {
    try {
      return this.#options.installFirst?.() ?? false
    } catch {
      return false
    }
  }
  /** Every policy decision accounts for what push already covers here. */
  #context(): ActivityContext {
    return { ...this.#options.context(), pushActive: this.#pushActive() }
  }
  publish(arrival?: ActivityRecord | null, preferencesChanged = false) {
    if (!this.#active) return
    if (arrival) {
      this.#queueLive(arrival)
    }
    this.#save(arrival?.id, preferencesChanged)
    this.#scheduleDelivery()
    this.#options.onChange()
  }
  #save(liveId?: string, preferencesChanged = false, deliveredId?: string) {
    try {
      try {
        const saved = this.#options.platform.read()
        const previous = saved && deserializeActivity(saved)
        if (previous && !preferencesChanged)
          this.#preferences = previous.preferences
      } catch {}
      const snapshot = serializeActivity({
        version: 3,
        preferences: this.#preferences,
      })
      try {
        this.#options.platform.write(snapshot)
      } catch {}
      try {
        this.#options.platform.send({
          snapshot,
          ...(liveId ? { liveId } : {}),
          ...(deliveredId ? { deliveredId } : {}),
          preferencesChanged,
        })
      } catch {}
    } catch {
      /* Never persist unvalidated data. */
    }
  }
  #receive(value: unknown) {
    if (!this.#active) return
    const parsed = messageSchema.safeParse(value)
    if (!parsed.success) return
    const snapshot = deserializeActivity(parsed.data.snapshot)
    if (!snapshot) return
    if (parsed.data.deliveredId)
      this.#options.store.markBrowserDelivered(
        parsed.data.deliveredId,
        new Date(this.#options.now()).toISOString()
      )
    if (parsed.data.preferencesChanged) {
      this.#preferences = snapshot.preferences
      try {
        const saved = this.#options.platform.read()
        const latest = saved && deserializeActivity(saved)
        if (latest) this.#preferences = latest.preferences
      } catch {}
    }
    if (parsed.data.liveId) {
      const record = this.#options.store
        .records()
        .find((item) => item.id === parsed.data.liveId)
      if (record) this.#queueLive(record)
      this.#scheduleDelivery()
    } else this.#prunePending()
    this.#options.onChange()
  }
  #queueLive(record: ActivityRecord) {
    try {
      if (
        getActivityPolicy(
          record,
          this.#context(),
          this.#preferences,
          this.#permission
        ).browserNotification
      ) {
        this.#pending.add(record.id)
      }
    } catch {}
  }
  #prunePending() {
    const records = new Map(
      this.#options.store.records().map((record) => [record.id, record])
    )
    for (const id of this.#pending) {
      const record = records.get(id)
      if (
        !record ||
        !getActivityPolicy(
          record,
          this.#context(),
          this.#preferences,
          this.#permission
        ).browserNotification
      )
        this.#pending.delete(id)
    }
  }
  #scheduleDelivery() {
    this.#prunePending()
    if (!this.#active || this.#settling || !this.#pending.size) return
    try {
      if (!this.#options.platform.isLeader()) return
      this.#settling = true
      const cancel = this.#options.platform.settleDelivery(() => {
        this.#settling = false
        this.#cancelSettlement = undefined
        if (!this.#active) return
        for (const id of this.#pending)
          if (this.#deliver(id)) this.#pending.delete(id)
        this.#prunePending()
        this.#options.onChange()
      })
      if (this.#settling) this.#cancelSettlement = cancel
    } catch {
      this.#settling = false
    }
  }
  #deliver(id: string): boolean {
    const { store, port, platform } = this.#options
    try {
      const saved = platform.read()
      const snapshot = saved && deserializeActivity(saved)
      if (snapshot) this.#preferences = snapshot.preferences
      const record = store.records().find((item) => item.id === id)
      if (!record || !platform.isLeader()) return false
      this.#permission = port.getPermission()
      if (
        !getActivityPolicy(
          record,
          this.#context(),
          this.#preferences,
          this.#permission
        ).browserNotification
      )
        return false
      const category = categoryOf(record.type)
      if (!category) return false
      const notification = port.show(
        {
          title: "AOS",
          body: this.#options.copy()[category],
          icon: "/logo-adaptive.svg",
          timestamp: Date.parse(record.occurredAt),
          tag: notificationTag(record.agentId, record.threadId, record.id),
          renotify: false,
        },
        () => {
          try {
            notification.close()
          } catch {}
          this.#notifications.delete(notification)
          if (!this.#active) return
          try {
            platform.focus()
          } catch {}
          try {
            void this.#options.open(id).catch(() => {})
          } catch {}
        }
      )
      this.#notifications.add(notification)
      store.markBrowserDelivered(
        id,
        new Date(this.#options.now()).toISOString()
      )
      // Peers only learn about a raised alert from this announcement, so a
      // failover leader never repeats it.
      this.#save(undefined, false, id)
      return true
    } catch {
      return false
    }
  }
}
