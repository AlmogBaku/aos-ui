import { describe, expect, it } from "vitest"

import { deserializeActivity, serializeActivity } from "./serialization"
import { ActivityStore } from "./store"
import { defaultBrowserPreferences } from "./policy"

const now = Date.parse("2026-09-05T12:00:00.000Z")
const record = {
  id: "finish-1",
  agentId: "agent-1",
  threadId: "thread-1",
  type: "run-finished" as const,
  lifecycleId: "run-1",
  occurredAt: new Date(now).toISOString(),
  read: true,
  resolved: false,
  browserDeliveredAt: "2026-09-05T12:00:01.000Z",
}
const snapshot = {
  version: 1,
  records: [record],
  preferences: defaultBrowserPreferences,
}
const makeStore = () =>
  new ActivityStore({
    now: () => now,
    getThreadOwner: (threadId) =>
      threadId === "thread-1" ? "agent-1" : undefined,
  })
const background = { selection: null, pageVisible: false, pageFocused: false }

describe("versioned Activity persistence", () => {
  it("round-trips metadata, read state, delivery state, and preferences", () => {
    const serialized = serializeActivity(snapshot)
    expect(deserializeActivity(serialized)).toEqual(snapshot)
  })

  it.each([
    "invalid-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...snapshot, version: 2 }),
    JSON.stringify({ ...snapshot, records: {} }),
    JSON.stringify({
      ...snapshot,
      preferences: { ...defaultBrowserPreferences, enabled: "yes" },
    }),
    JSON.stringify({ ...snapshot, records: [{ ...record, read: "yes" }] }),
    JSON.stringify({ ...snapshot, records: [{ ...record, resolved: 1 }] }),
    JSON.stringify({
      ...snapshot,
      records: [{ ...record, browserDeliveredAt: "not-a-date" }],
    }),
    JSON.stringify({
      ...snapshot,
      records: [{ ...record, occurredAt: "2026-02-30T12:00:00.000Z" }],
    }),
    JSON.stringify({ ...snapshot, records: [{ ...record, lifecycleId: "" }] }),
    JSON.stringify({ ...snapshot, records: [{ ...record, agentId: null }] }),
    JSON.stringify({
      ...snapshot,
      records: [{ ...record, type: "run-started" }],
    }),
    JSON.stringify({
      ...snapshot,
      records: [{ ...record, message: "private-message" }],
    }),
    JSON.stringify({ ...snapshot, extra: "private-value" }),
  ])("rejects malformed or unexpected persisted data %#", (serialized) => {
    expect(deserializeActivity(serialized)).toBeNull()
  })

  it("projects both records and preferences onto the privacy allowlist before writing", () => {
    const secrets = {
      message: "private-message",
      prompt: "private-prompt",
      tool: "private-tool",
      todo: "private-todo",
      question: "private-question",
      permission: "private-permission",
      error: "private-error",
      name: "private-agent-name",
      title: "private-thread-title",
    }
    const serialized = serializeActivity({
      ...snapshot,
      records: [{ ...record, ...secrets }],
      preferences: { ...defaultBrowserPreferences, ...secrets },
      ...secrets,
    })
    expect(JSON.parse(serialized)).toEqual(snapshot)
    for (const secret of Object.values(secrets))
      expect(serialized).not.toContain(secret)
  })

  it("rejects duplicate event IDs and conflicting thread ownership in storage", () => {
    expect(
      deserializeActivity(
        JSON.stringify({ ...snapshot, records: [record, record] })
      )
    ).toBeNull()
    expect(
      deserializeActivity(
        JSON.stringify({
          ...snapshot,
          records: [
            record,
            { ...record, id: "another", agentId: "wrong-owner" },
          ],
        })
      )
    ).toBeNull()
  })

  it("rejects oversized persisted arrays", () => {
    expect(
      deserializeActivity(
        JSON.stringify({
          ...snapshot,
          records: Array.from({ length: 201 }, (_, index) => ({
            ...record,
            id: `event-${index}`,
          })),
        })
      )
    ).toBeNull()
  })
})

describe("Activity hydration", () => {
  it("preserves a live resolution when an older attention snapshot arrives later", () => {
    const store = makeStore()
    store.ingest(
      {
        ...record,
        id: "resolution",
        type: "attention-resolved",
        requestId: "request-1",
      },
      background
    )
    store.hydrate([
      {
        id: "request",
        agentId: "agent-1",
        threadId: "thread-1",
        occurredAt: record.occurredAt,
        type: "attention-requested",
        attentionKind: "question",
        requestId: "request-1",
        read: false,
        resolved: false,
        browserDeliveredAt: null,
      },
    ])
    expect(store.records()[0]?.resolved).toBe(true)
  })

  it("restores existing Activity without replaying hydrated lifecycle completions", () => {
    const store = makeStore()
    store.hydrate(snapshot.records)
    expect(store.records()).toEqual([record])
    expect(
      store.ingest(
        { ...record, type: "run-started", id: "start-1" },
        background
      )
    ).toBeNull()
    expect(
      store.ingest({ ...record, id: "replayed-finish" }, background)
    ).toBeNull()
    expect(store.records()).toEqual([record])
  })

  it("rejects malformed hydration and known wrong owners, preserving unavailable targets", () => {
    const store = makeStore()
    store.hydrate([
      { ...record, agentId: "wrong-owner" },
      { ...record, id: "deleted", threadId: "deleted-thread" },
      { ...record, id: "malformed", read: "yes" },
    ])
    expect(store.records().map((entry) => entry.id)).toEqual(["deleted"])
  })

  it("keeps read, resolved, and delivered states monotonic across older snapshots", () => {
    const store = makeStore()
    const request = {
      ...record,
      type: "attention-requested",
      attentionKind: "permission",
      requestId: "request-1",
      lifecycleId: undefined,
      read: false,
      browserDeliveredAt: null,
    }
    // Serialization projects the correct variant before hydration.
    const clean = JSON.parse(
      serializeActivity({ ...snapshot, records: [request] })
    ).records
    store.hydrate(clean)
    store.markRead(record.id)
    store.markUnavailable(record.id)
    store.markBrowserDelivered(record.id, "2026-09-05T12:00:02.000Z")
    store.hydrate(clean)
    expect(store.records()[0]).toMatchObject({
      read: true,
      resolved: true,
      browserDeliveredAt: "2026-09-05T12:00:02.000Z",
    })
  })

  it("applies retention to hydrated records", () => {
    const store = makeStore()
    store.hydrate([{ ...record, occurredAt: "2026-08-01T12:00:00.000Z" }])
    expect(store.records()).toEqual([])
  })

  it("does not serialize live start bookkeeping", () => {
    const store = makeStore()
    store.ingest({ ...record, id: "start-1", type: "run-started" }, background)
    const persisted = serializeActivity({
      ...snapshot,
      records: store.records(),
    })
    expect(JSON.parse(persisted).records).toEqual([])
    expect(persisted).not.toContain("run-1")
  })
})
