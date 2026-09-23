import type {
  SessionMetadata,
  WorkspaceActivityEvent,
} from "@/runtime-adapters/contracts"
import { isSessionUnread } from "@/lib/workspace-view-model"
import {
  ACTIVITY_MAX_AGE_MS,
  activityEventSchema,
  activityScope,
  activityTimestamp,
  retainActivity,
  type ActivityEntry,
  type ActivityRecord,
  type VisibleActivityEvent,
} from "./activity"

type RunTerminal = Extract<
  WorkspaceActivityEvent,
  { type: "turn-finished" | "turn-failed" }
>
type StoreOptions = {
  now: () => number
  getThreadOwner: (threadId: string) => string | undefined
  /** Authoritative Session state; read state is derived from it, never stored. */
  getSessions: () => readonly SessionMetadata[]
}

export class ActivityStore {
  readonly #options: StoreOptions
  #records = new Map<string, ActivityEntry>()
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

  /** Returns only a newly created entry; bookkeeping/duplicates return null. */
  ingest(input: unknown): ActivityRecord | null {
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
      event.type === "turn-started" ||
      event.type === "turn-finished" ||
      event.type === "turn-failed"
    ) {
      const key = activityScope(event, event.turnId)
      if (this.#closedLifecycles.has(key)) return null
      if (event.type === "turn-started") {
        const startedAt = this.#starts.get(key) ?? event.occurredAt
        this.#starts.set(key, startedAt)
        const terminal = [
          ...(this.#pendingTerminals.get(key)?.values() ?? []),
        ].find(
          (candidate) =>
            Date.parse(candidate.occurredAt) >= Date.parse(startedAt)
        )
        return terminal ? this.#complete(terminal) : null
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
      return this.#complete(event)
    }

    return this.#insert(event)
  }

  records(): ActivityRecord[] {
    this.#prune()
    const unread = this.#unreadThreads()
    return [...this.#records.values()].map((entry) => ({
      ...entry,
      read: !unread.has(entry.threadId),
    }))
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

  #complete(event: RunTerminal) {
    if (this.#records.has(event.id)) return null
    const key = activityScope(event, event.turnId)
    const startedAt = this.#starts.get(key)
    if (!startedAt || Date.parse(event.occurredAt) < Date.parse(startedAt))
      return null
    this.#starts.delete(key)
    this.#pendingTerminals.delete(key)
    this.#closedLifecycles.add(key)
    return this.#insert(event)
  }

  #insert(event: VisibleActivityEvent): ActivityRecord | null {
    const entry: ActivityEntry = {
      ...event,
      resolved:
        event.type === "attention-requested" &&
        this.#resolvedRequests.has(activityScope(event, event.requestId)),
      browserDeliveredAt: null,
    }
    this.#records.set(entry.id, entry)
    this.#prune()
    return this.#records.has(entry.id)
      ? { ...entry, read: !this.#unreadThreads().has(entry.threadId) }
      : null
  }

  /** A Session is unread as a whole, so all of its entries agree. */
  #unreadThreads() {
    return new Set(
      this.#options
        .getSessions()
        .filter(isSessionUnread)
        .map(({ threadId }) => threadId)
    )
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
      if (event.type === "turn-started")
        starts.add(activityScope(event, event.turnId))
      if (event.type === "turn-finished" || event.type === "turn-failed")
        terminals.add(activityScope(event, event.turnId))
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
      "turnId" in event ? event.turnId : null,
      "requestId" in event ? event.requestId : null,
      "attentionKind" in event ? event.attentionKind : null,
    ])
  }
}
