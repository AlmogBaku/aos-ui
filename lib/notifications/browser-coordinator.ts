import { z } from "zod"
import type { ActivityRecord } from "./activity"
import type { ActivityStore } from "./store"
import type { BrowserNotificationPort } from "./browser-port"
import {
  defaultBrowserPreferences,
  getActivityPolicy,
  type ActivityContext,
  type BrowserPermission,
  type BrowserPreferences,
} from "./policy"
import { deserializeActivity, serializeActivity } from "./serialization"

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
}
const messageSchema = z
  .object({
    snapshot: z.string().max(1_000_000),
    liveId: z.string().max(512).optional(),
    preferencesChanged: z.boolean(),
  })
  .strict()

/** Live arrivals are explicit; hydration and leadership changes never replay OS alerts. */
export class BrowserActivityCoordinator {
  readonly #options: BrowserActivityOptions
  #preferences: BrowserPreferences = { ...defaultBrowserPreferences }
  #permission: BrowserPermission = "unsupported"
  #active = false
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
      if (snapshot) {
        this.#options.store.hydrate(snapshot.records)
        this.#preferences = snapshot.preferences
      }
    } catch {
      /* Storage may be blocked; Activity stays usable. */
    }
    this.recheckPermission()
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
    return { status: this.#permission, preferences: { ...this.#preferences } }
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
  setCategory(category: "completion" | "failure" | "input", enabled: boolean) {
    this.#preferences[category] = enabled
    this.publish(undefined, true)
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
  #save(liveId?: string, preferencesChanged = false, broadcast = true) {
    try {
      try {
        const saved = this.#options.platform.read()
        const previous = saved && deserializeActivity(saved)
        if (previous) {
          this.#options.store.hydrate(previous.records)
          if (!preferencesChanged) this.#preferences = previous.preferences
        }
      } catch {}
      const snapshot = serializeActivity({
        version: 1,
        records: this.#options.store.records(),
        preferences: this.#preferences,
      })
      try {
        this.#options.platform.write(snapshot)
      } catch {}
      try {
        if (broadcast)
          this.#options.platform.send({
            snapshot,
            ...(liveId ? { liveId } : {}),
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
    this.#options.store.hydrate(snapshot.records)
    let readChanged = false
    for (const record of this.#options.store.records()) {
      if (
        !record.read &&
        getActivityPolicy(
          record,
          this.#options.context(),
          this.#preferences,
          this.#permission
        ).markRead
      ) {
        this.#options.store.markRead(record.id)
        readChanged = true
      }
    }
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
    }
    // Persist merged monotonic state without echoing every received snapshot.
    this.#save(undefined, false, readChanged)
    if (parsed.data.liveId) this.#scheduleDelivery()
    else this.#prunePending()
    this.#options.onChange()
  }
  #queueLive(record: ActivityRecord) {
    try {
      if (
        getActivityPolicy(
          record,
          this.#options.context(),
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
          this.#options.context(),
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
        // Peers receive the arrival before settlement and can persist exact-
        // foreground read state. Each attempt rereads that merged snapshot.
        for (const id of this.#pending)
          if (this.#deliver(id)) this.#pending.delete(id)
        this.#prunePending()
        this.#save()
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
      if (snapshot) {
        store.hydrate(snapshot.records)
        this.#preferences = snapshot.preferences
      }
      const record = store.records().find((item) => item.id === id)
      if (!record || !platform.isLeader()) return false
      this.#permission = port.getPermission()
      if (
        !getActivityPolicy(
          record,
          this.#options.context(),
          this.#preferences,
          this.#permission
        ).browserNotification
      )
        return false
      const category =
        record.type === "attention-requested"
          ? "input"
          : record.type === "run-failed" ||
              record.type === "agent-activation-failed"
            ? "failure"
            : "completion"
      // Only a hash of opaque identity appears on the OS surface.
      let hash = 2166136261
      for (const char of JSON.stringify([
        record.agentId,
        record.threadId,
        record.id,
      ]))
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
      const notification = port.show(
        {
          title: "AOS",
          body: this.#options.copy()[category],
          icon: "/logo-adaptive.svg",
          timestamp: Date.parse(record.occurredAt),
          tag: `aos-ui-${(hash >>> 0).toString(16)}`,
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
      return true
    } catch {
      return false
    }
  }
}
