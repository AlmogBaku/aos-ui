import type { WorkspaceActivityEvent } from "@/lib/runtime-adapters/contracts"
import {
  ACTIVITY_MAX_AGE_MS,
  activityEventSchema,
  activityScope,
  activityTimestamp,
  storedActivityRecordSchema,
  retainActivity,
  type ActivityRecord,
  type VisibleActivityEvent,
} from "./activity"
import {
  defaultBrowserPreferences,
  getActivityPolicy,
  type ActivityContext,
} from "./policy"

type RunTerminal = Extract<
  WorkspaceActivityEvent,
  { type: "run-finished" | "run-failed" }
>
type StoreOptions = {
  now: () => number
  getThreadOwner: (threadId: string) => string | undefined
}

export class ActivityStore {
  readonly #options: StoreOptions
  #records = new Map<string, ActivityRecord>()
  readonly #starts = new Map<string, string>()
  readonly #pendingTerminals = new Map<string, Map<string, RunTerminal>>()
  readonly #closedLifecycles = new Set<string>()
  readonly #resolvedRequests = new Set<string>()
  readonly #identities = new Map<
    string,
    {
      event: WorkspaceActivityEvent
      expiresAt: number
    }
  >()

  constructor(options: StoreOptions) {
    this.#options = options
  }

  /** Merge persisted/tab state without emitting arrivals or restoring live runs. */
  hydrate(records: unknown) {
    this.#prune()
    if (!Array.isArray(records)) return
    for (const input of records) {
      const parsed = storedActivityRecordSchema.safeParse(input)
      if (!parsed.success) continue
      const incoming = parsed.data
      const owner = this.#options.getThreadOwner(incoming.threadId)
      if (owner !== undefined && owner !== incoming.agentId) continue
      if (
        [...this.#records.values()].some(
          (record) =>
            record.threadId === incoming.threadId &&
            record.agentId !== incoming.agentId
        )
      )
        continue
      const existing = this.#records.get(incoming.id)
      if (
        existing &&
        JSON.stringify(activityEventSchema.parse(existing)) !==
          JSON.stringify(activityEventSchema.parse(incoming))
      )
        continue
      if (!this.#remember(incoming)) continue
      const record: ActivityRecord = existing
        ? {
            ...existing,
            read: existing.read || incoming.read,
            resolved: existing.resolved || incoming.resolved,
            browserDeliveredAt:
              existing.browserDeliveredAt ?? incoming.browserDeliveredAt,
          }
        : incoming
      this.#records.set(record.id, record)
      if (record.type === "run-finished" || record.type === "run-failed") {
        const key = activityScope(record, record.lifecycleId)
        this.#closedLifecycles.add(key)
        this.#starts.delete(key)
        this.#pendingTerminals.delete(key)
      }
      if (record.type === "attention-requested") {
        const key = activityScope(record, record.requestId)
        record.resolved ||= this.#resolvedRequests.has(key)
        if (record.resolved) this.#resolvedRequests.add(key)
      }
    }
    this.#prune()
  }

  /** Returns only a newly created entry; bookkeeping/duplicates return null. */
  ingest(input: unknown, context: ActivityContext): ActivityRecord | null {
    this.#prune()
    const parsed = activityEventSchema.safeParse(input)
    if (!parsed.success) return null
    const event = parsed.data
    if (this.#options.getThreadOwner(event.threadId) !== event.agentId)
      return null
    if (this.#records.has(event.id)) return null
    if (!this.#remember(event)) return null

    if (event.type === "attention-resolved") {
      const key = activityScope(event, event.requestId)
      this.#resolvedRequests.add(key)
      for (const record of this.#records.values()) {
        if (
          record.type === "attention-requested" &&
          activityScope(record, record.requestId) === key
        )
          record.resolved = true
      }
      this.#prune()
      return null
    }

    if (
      event.type === "run-started" ||
      event.type === "run-finished" ||
      event.type === "run-failed"
    ) {
      const key = activityScope(event, event.lifecycleId)
      if (this.#closedLifecycles.has(key)) return null
      if (event.type === "run-started") {
        const startedAt = this.#starts.get(key) ?? event.occurredAt
        this.#starts.set(key, startedAt)
        const terminal = [
          ...(this.#pendingTerminals.get(key)?.values() ?? []),
        ].find(
          (candidate) =>
            Date.parse(candidate.occurredAt) >= Date.parse(startedAt)
        )
        return terminal ? this.#complete(terminal, context) : null
      }
      if (!this.#starts.has(key)) {
        const candidates =
          this.#pendingTerminals.get(key) ?? new Map<string, RunTerminal>()
        const pending = candidates.get(event.id)
        // Preserve first-observed closing order across distinct IDs. A corrected
        // timestamp updates only its duplicate candidate, without moving it.
        if (
          !pending ||
          Date.parse(event.occurredAt) > Date.parse(pending.occurredAt)
        )
          candidates.set(event.id, event)
        this.#pendingTerminals.set(key, candidates)
        return null
      }
      return this.#complete(event, context)
    }

    return this.#insert(event, context)
  }

  records(): ActivityRecord[] {
    this.#prune()
    return [...this.#records.values()].map((record) => ({ ...record }))
  }

  markRead(id: string) {
    const record = this.#records.get(id)
    if (record) record.read = true
  }

  markAllRead() {
    for (const record of this.#records.values()) record.read = true
  }

  markBrowserDelivered(id: string, occurredAt: string) {
    const record = this.#records.get(id)
    if (
      record &&
      activityTimestamp.safeParse(occurredAt).success &&
      !record.browserDeliveredAt
    )
      record.browserDeliveredAt = occurredAt
  }

  markUnavailable(id: string) {
    const record = this.#records.get(id)
    if (record) {
      record.resolved = true
      if (record.type === "attention-requested")
        this.#resolvedRequests.add(activityScope(record, record.requestId))
    }
    this.#prune()
  }

  #complete(event: RunTerminal, context: ActivityContext) {
    if (this.#records.has(event.id)) return null
    const key = activityScope(event, event.lifecycleId)
    const startedAt = this.#starts.get(key)
    if (!startedAt || Date.parse(event.occurredAt) < Date.parse(startedAt))
      return null
    this.#starts.delete(key)
    this.#pendingTerminals.delete(key)
    this.#closedLifecycles.add(key)
    return this.#insert(event, context)
  }

  #insert(
    event: VisibleActivityEvent,
    context: ActivityContext
  ): ActivityRecord | null {
    const record: ActivityRecord = {
      ...event,
      read: getActivityPolicy(
        event,
        context,
        defaultBrowserPreferences,
        "unsupported"
      ).markRead,
      resolved:
        event.type === "attention-requested" &&
        this.#resolvedRequests.has(activityScope(event, event.requestId)),
      browserDeliveredAt: null,
    }
    this.#records.set(record.id, record)
    this.#prune()
    return this.#records.has(record.id) ? { ...record } : null
  }

  #prune() {
    const now = this.#options.now()
    this.#records = new Map(
      retainActivity(
        [...this.#records.values()].filter(
          (record) => !this.#hasWrongOwner(record)
        ),
        now
      ).map((record) => [record.id, record])
    )
    // A retained record keeps its own identity. All other identities and the
    // bookkeeping supported by them expire 30 days after first observation;
    // replaying the same ID does not extend that window.
    const starts = new Set<string>()
    const terminals = new Set<string>()
    const resolutions = new Set<string>()
    for (const [id, { event, expiresAt }] of this.#identities) {
      if (
        this.#hasWrongOwner(event) ||
        (expiresAt <= now && !this.#records.has(id))
      ) {
        this.#identities.delete(id)
        continue
      }
      if (event.type === "run-started")
        starts.add(activityScope(event, event.lifecycleId))
      if (event.type === "run-finished" || event.type === "run-failed")
        terminals.add(activityScope(event, event.lifecycleId))
      if (event.type === "attention-resolved")
        resolutions.add(activityScope(event, event.requestId))
    }
    for (const record of this.#records.values()) {
      if (record.type === "attention-requested" && record.resolved)
        resolutions.add(activityScope(record, record.requestId))
    }
    for (const key of this.#starts.keys())
      if (!starts.has(key)) this.#starts.delete(key)
    for (const [key, candidates] of this.#pendingTerminals) {
      for (const id of candidates.keys())
        if (!this.#identities.has(id)) candidates.delete(id)
      if (!candidates.size) this.#pendingTerminals.delete(key)
    }
    for (const key of this.#closedLifecycles)
      if (!terminals.has(key)) this.#closedLifecycles.delete(key)
    for (const key of this.#resolvedRequests)
      if (!resolutions.has(key)) this.#resolvedRequests.delete(key)
  }

  #hasWrongOwner(event: WorkspaceActivityEvent) {
    const owner = this.#options.getThreadOwner(event.threadId)
    return owner !== undefined && owner !== event.agentId
  }

  #remember(event: WorkspaceActivityEvent) {
    const previous = this.#identities.get(event.id)
    if (previous && this.#identity(previous.event) !== this.#identity(event))
      return false
    if (!previous)
      this.#identities.set(event.id, {
        event: activityEventSchema.parse(event),
        expiresAt: this.#options.now() + ACTIVITY_MAX_AGE_MS,
      })
    return true
  }

  #identity(event: WorkspaceActivityEvent) {
    return JSON.stringify([
      event.agentId,
      event.threadId,
      event.type,
      "lifecycleId" in event ? event.lifecycleId : null,
      "requestId" in event ? event.requestId : null,
      "attentionKind" in event ? event.attentionKind : null,
    ])
  }
}
