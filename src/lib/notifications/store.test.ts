import { describe, expect, it } from "vitest"

import type { WorkspaceActivityEvent } from "@/runtime-adapters/contracts"
import { ActivityStore } from "./store"
import { serializeActivity } from "./serialization"
import { defaultBrowserPreferences } from "./policy"

const now = Date.parse("2026-09-05T12:00:00.000Z")
const background = { selection: null, pageVisible: false, pageFocused: false }
const base = {
  agentId: "agent-1",
  threadId: "thread-1",
  occurredAt: new Date(now).toISOString(),
}
const ready: WorkspaceActivityEvent = {
  ...base,
  id: "ready-1",
  type: "agent-ready",
}
const start: WorkspaceActivityEvent = {
  ...base,
  id: "start-1",
  type: "run-started",
  lifecycleId: "run-1",
}
const finish: WorkspaceActivityEvent = {
  ...base,
  id: "finish-1",
  type: "run-finished",
  lifecycleId: "run-1",
  occurredAt: "2026-09-05T12:00:01.000Z",
}
const request: WorkspaceActivityEvent = {
  ...base,
  id: "request-event",
  type: "attention-requested",
  attentionKind: "question",
  requestId: "request-1",
}
const resolution: WorkspaceActivityEvent = {
  ...base,
  id: "resolution-event",
  type: "attention-resolved",
  requestId: "request-1",
}
const makeStore = () =>
  new ActivityStore({
    now: () => now,
    getThreadOwner: (threadId: string) =>
      ({ "thread-1": "agent-1", "thread-2": "agent-2" })[threadId],
  })

describe("Activity store", () => {
  it.each(["start", "terminal"] as const)(
    "expires abandoned %s bookkeeping after 30 days",
    (kind) => {
      let time = now
      const store = new ActivityStore({
        now: () => time,
        getThreadOwner: () => "agent-1",
      })
      store.ingest(kind === "start" ? start : finish, background)
      time += 30 * 24 * 60 * 60 * 1000
      const freshTime = new Date(time).toISOString()
      const counterpart =
        kind === "start" ? { ...finish, occurredAt: freshTime } : start
      expect(store.ingest(counterpart, background)).toBeNull()
      expect(store.records()).toEqual([])
    }
  )

  it("retains early resolution and identity deduplication only for the 30-day window", () => {
    let time = now
    const store = new ActivityStore({
      now: () => time,
      getThreadOwner: () => "agent-1",
    })
    store.ingest(resolution, background)
    time += 30 * 24 * 60 * 60 * 1000 - 1
    expect(
      store.ingest(
        {
          ...ready,
          id: resolution.id,
          occurredAt: new Date(time).toISOString(),
        },
        background
      )
    ).toBeNull()
    time += 1
    expect(
      store.ingest(
        { ...request, occurredAt: new Date(time).toISOString() },
        background
      )?.resolved
    ).toBe(false)
    expect(
      store.ingest(
        {
          ...ready,
          id: resolution.id,
          occurredAt: new Date(time).toISOString(),
        },
        background
      )?.type
    ).toBe("agent-ready")
  })

  it("expires closed lifecycle bookkeeping with expired records", () => {
    let time = now
    const store = new ActivityStore({
      now: () => time,
      getThreadOwner: () => "agent-1",
    })
    store.ingest(start, background)
    store.ingest(finish, background)
    time += 30 * 24 * 60 * 60 * 1000 + 1001
    const occurredAt = new Date(time).toISOString()
    store.ingest({ ...start, occurredAt }, background)
    expect(store.ingest({ ...finish, occurredAt }, background)?.id).toBe(
      finish.id
    )
  })

  it("reserves a buffered terminal's ID before a conflicting visible event arrives", () => {
    const store = makeStore()
    store.ingest(finish, background)
    expect(store.ingest({ ...ready, id: finish.id }, background)).toBeNull()
    expect(store.ingest(start, background)?.type).toBe("run-finished")
    expect(store.records()[0]?.type).toBe("run-finished")
  })

  it.each(["read", "ingest", "hydrate"] as const)(
    "reconciles previously unknown ownership before %s",
    (transition) => {
      const ownership: { owner?: string } = {}
      const store = new ActivityStore({
        now: () => now,
        getThreadOwner: () => ownership.owner,
      })
      store.hydrate([
        { ...ready, read: false, resolved: false, browserDeliveredAt: null },
      ])
      expect(store.records()).toHaveLength(1)
      ownership.owner = "agent-2"
      const authoritative = {
        ...ready,
        id: "correct-owner",
        agentId: "agent-2",
      }
      if (transition === "ingest") store.ingest(authoritative, background)
      if (transition === "hydrate")
        store.hydrate([
          {
            ...authoritative,
            read: false,
            resolved: false,
            browserDeliveredAt: null,
          },
        ])
      expect(store.records().map((record) => record.agentId)).toEqual(
        transition === "read" ? [] : ["agent-2"]
      )
      expect(() =>
        serializeActivity({
          version: 1,
          records: store.records(),
          preferences: defaultBrowserPreferences,
        })
      ).not.toThrow()
    }
  )

  it.each([
    ["stale-first", true, false],
    ["valid-first", false, false],
    ["stale-first with distinct IDs", true, true],
    ["valid-first with distinct IDs", false, true],
  ] as const)(
    "reconciles buffered terminals %s",
    (_label, staleFirst, distinctIds) => {
      const store = makeStore()
      const stale = {
        ...finish,
        id: distinctIds ? "stale-terminal" : finish.id,
        occurredAt: "2026-09-05T11:59:59.000Z",
      }
      for (const candidate of staleFirst ? [stale, finish] : [finish, stale])
        store.ingest(candidate, background)
      expect(store.ingest(start, background)?.id).toBe("finish-1")
      expect(store.records()[0]?.occurredAt).toBe("2026-09-05T12:00:01.000Z")
    }
  )

  it.each([start, finish, resolution])(
    "rejects cross-origin reuse of bookkeeping ID $id",
    (bookkeeping) => {
      const store = makeStore()
      store.ingest(bookkeeping, background)
      store.ingest(
        {
          ...request,
          id: "agent-2-request",
          agentId: "agent-2",
          threadId: "thread-2",
        },
        background
      )
      store.ingest(
        {
          ...resolution,
          id: bookkeeping.id,
          agentId: "agent-2",
          threadId: "thread-2",
        },
        background
      )
      expect(
        store.records().find((record) => record.id === "agent-2-request")
          ?.resolved
      ).toBe(false)
    }
  )

  it.each([start, finish, resolution])(
    "rejects cross-type reuse of bookkeeping ID $id",
    (bookkeeping) => {
      const store = makeStore()
      store.ingest(bookkeeping, background)
      expect(
        store.ingest({ ...ready, id: bookkeeping.id }, background)
      ).toBeNull()
      expect(store.records()).toEqual([])
    }
  )

  it("rejects resolution ID reuse for another request at the same origin", () => {
    const store = makeStore()
    store.ingest(resolution, background)
    store.ingest({ ...request, requestId: "request-2" }, background)
    store.ingest({ ...resolution, requestId: "request-2" }, background)
    expect(store.records()[0]?.resolved).toBe(false)
  })

  it("rejects start ID reuse for another lifecycle at the same origin", () => {
    const store = makeStore()
    store.ingest(start, background)
    store.ingest({ ...start, lifecycleId: "run-2" }, background)
    store.ingest({ ...finish, lifecycleId: "run-2" }, background)
    expect(store.records()).toEqual([])
  })

  it("records terminal activation events without retaining caller-owned payloads", () => {
    const store = makeStore()
    const payload = {
      ...ready,
      message: "private-message",
      error: "private-error",
    }
    expect(store.ingest(payload, background)).toMatchObject({
      id: "ready-1",
      read: false,
      resolved: false,
    })
    payload.agentId = "changed"
    expect(store.records()).toEqual([
      { ...ready, read: false, resolved: false, browserDeliveredAt: null },
    ])
    const snapshot = store.records()
    snapshot[0].read = true
    expect(store.records()[0].read).toBe(false)
  })

  it.each([
    null,
    {},
    { ...ready, agentId: "agent-2" },
    { ...ready, threadId: "unknown" },
    { ...ready, occurredAt: "invalid" },
    { ...ready, id: "" },
  ])("rejects malformed or unowned ingestion %j", (event) => {
    const store = makeStore()
    expect(store.ingest(event, background)).toBeNull()
    expect(store.records()).toEqual([])
  })

  it("pairs a start and terminal exactly once without displaying the start", () => {
    const store = makeStore()
    expect(store.ingest(start, background)).toBeNull()
    expect(store.records()).toEqual([])
    expect(store.ingest(finish, background)?.type).toBe("run-finished")
    expect(store.ingest(finish, background)).toBeNull()
    expect(
      store.ingest({ ...finish, id: "duplicate-terminal" }, background)
    ).toBeNull()
    expect(store.records().map((record) => record.id)).toEqual(["finish-1"])
  })

  it("buffers a terminal until its observed start arrives out of order", () => {
    const store = makeStore()
    expect(store.ingest(finish, background)).toBeNull()
    expect(store.records()).toEqual([])
    expect(store.ingest(start, background)?.id).toBe("finish-1")
    expect(store.ingest(start, background)).toBeNull()
    expect(store.records()).toHaveLength(1)
  })

  it("does not pair lifecycles across Agents, Sessions, or IDs", () => {
    const store = makeStore()
    store.ingest(start, background)
    store.ingest(
      { ...finish, id: "other-run-terminal", lifecycleId: "other-run" },
      background
    )
    store.ingest(
      {
        ...finish,
        id: "other-session",
        agentId: "agent-2",
        threadId: "thread-2",
      },
      background
    )
    expect(store.records()).toEqual([])
    expect(store.ingest(finish, background)?.id).toBe("finish-1")
  })

  it("preserves the first valid failure when completion arrives before a delayed start", () => {
    const store = makeStore()
    store.ingest({ ...finish, id: "failure", type: "run-failed" }, background)
    store.ingest(
      {
        ...finish,
        id: "later-completion",
        occurredAt: "2026-09-05T12:00:02.000Z",
      },
      background
    )
    expect(store.ingest(start, background)?.type).toBe("run-failed")
    expect(store.records().map((record) => record.type)).toEqual(["run-failed"])
  })

  it("preserves the first valid completion when failure arrives before a delayed start", () => {
    const store = makeStore()
    store.ingest(finish, background)
    store.ingest(
      {
        ...finish,
        id: "later-failure",
        type: "run-failed",
        occurredAt: "2026-09-05T12:00:02.000Z",
      },
      background
    )
    expect(store.ingest(start, background)?.type).toBe("run-finished")
  })

  it("corrects a duplicate terminal timestamp without moving its closing order", () => {
    const store = makeStore()
    store.ingest(
      {
        ...finish,
        id: "failure",
        type: "run-failed",
        occurredAt: "2026-09-05T11:59:59.000Z",
      },
      background
    )
    store.ingest(
      {
        ...finish,
        id: "later-completion",
        occurredAt: "2026-09-05T12:00:03.000Z",
      },
      background
    )
    store.ingest({ ...finish, id: "failure", type: "run-failed" }, background)
    expect(store.ingest(start, background)?.type).toBe("run-failed")
  })

  it("pairs failures and prevents a later completion for the failed lifecycle", () => {
    const store = makeStore()
    store.ingest(start, background)
    expect(
      store.ingest({ ...finish, type: "run-failed" }, background)?.type
    ).toBe("run-failed")
    store.ingest({ ...finish, id: "late-finish" }, background)
    expect(store.records().map((record) => record.type)).toEqual(["run-failed"])
  })

  it("rejects a terminal timestamp older than the observed start", () => {
    const store = makeStore()
    store.ingest(start, background)
    store.ingest(
      { ...finish, occurredAt: "2026-09-05T11:59:59.000Z" },
      background
    )
    expect(store.records()).toEqual([])
    expect(store.ingest(finish, background)?.id).toBe("finish-1")
  })

  it("preserves read and delivery bookkeeping across older duplicate events", () => {
    const store = makeStore()
    store.ingest(ready, background)
    store.markRead(ready.id)
    store.markBrowserDelivered(ready.id, base.occurredAt)
    expect(
      store.ingest(
        { ...ready, occurredAt: "2026-09-04T12:00:00.000Z" },
        background
      )
    ).toBeNull()
    expect(store.records()).toEqual([
      {
        ...ready,
        read: true,
        resolved: false,
        browserDeliveredAt: base.occurredAt,
      },
    ])
  })

  it("rejects reuse of an event ID by another owned target", () => {
    const store = makeStore()
    store.ingest(ready, background)
    expect(
      store.ingest(
        { ...ready, agentId: "agent-2", threadId: "thread-2" },
        background
      )
    ).toBeNull()
    expect(store.records()[0].agentId).toBe("agent-1")
  })

  it("sorts out-of-order records newest first with stable ID ordering for ties", () => {
    const store = makeStore()
    store.ingest(
      { ...ready, id: "b", occurredAt: "2026-09-05T11:00:00.000Z" },
      background
    )
    store.ingest({ ...ready, id: "c" }, background)
    store.ingest({ ...ready, id: "a" }, background)
    expect(store.records().map((record) => record.id)).toEqual(["a", "c", "b"])
  })

  it("marks only the exact visible focused origin read on arrival", () => {
    const store = makeStore()
    store.ingest(ready, {
      pageVisible: true,
      pageFocused: true,
      selection: { agentId: "agent-1", threadId: "thread-1" },
    })
    store.ingest(
      { ...ready, id: "other", agentId: "agent-2", threadId: "thread-2" },
      {
        pageVisible: true,
        pageFocused: true,
        selection: { agentId: "agent-1", threadId: "thread-1" },
      }
    )
    expect(store.records().map((record) => [record.id, record.read])).toEqual([
      ["other", false],
      ["ready-1", true],
    ])
    store.markAllRead()
    expect(store.records().every((record) => record.read)).toBe(true)
  })

  it("resolves only the matching attention request without creating a follow-up entry", () => {
    const store = makeStore()
    store.ingest(request, background)
    store.ingest(
      { ...request, id: "other-request", requestId: "request-2" },
      background
    )
    expect(store.ingest(resolution, background)).toBeNull()
    store.ingest(request, background)
    expect(
      store.records().map((record) => [record.id, record.resolved])
    ).toEqual([
      ["other-request", false],
      ["request-event", true],
    ])
  })

  it("remembers an early resolution without reopening a delayed attention event", () => {
    const store = makeStore()
    store.ingest(resolution, background)
    expect(store.ingest(request, background)?.resolved).toBe(true)
    expect(store.records()).toHaveLength(1)
  })

  it("never resolves a different origin sharing the request ID", () => {
    const store = makeStore()
    store.ingest(request, background)
    store.ingest(
      { ...resolution, agentId: "agent-2", threadId: "thread-2" },
      background
    )
    expect(store.records()[0].resolved).toBe(false)
  })

  it("marks a deleted target resolved while preserving its Activity entry", () => {
    const store = makeStore()
    store.ingest(request, background)
    store.markUnavailable(request.id)
    expect(store.records()[0]).toMatchObject({ id: request.id, resolved: true })
  })

  it("expires 30-day ordinary/resolved records while preserving unresolved attention", () => {
    const store = makeStore()
    const old = "2026-08-06T12:00:00.000Z"
    store.ingest({ ...request, occurredAt: old }, background)
    store.ingest({ ...ready, occurredAt: old }, background)
    store.ingest(
      { ...ready, id: "recent", occurredAt: "2026-08-06T12:00:00.001Z" },
      background
    )
    expect(store.records().map((record) => record.id)).toEqual([
      "recent",
      "request-event",
    ])
    store.ingest(resolution, background)
    expect(store.records().map((record) => record.id)).toEqual(["recent"])
  })

  it("caps entries at 200, retaining old unresolved attention before ordinary entries", () => {
    const store = makeStore()
    store.ingest(
      { ...request, occurredAt: "2026-07-01T00:00:00.000Z" },
      background
    )
    for (let index = 0; index < 205; index++) {
      store.ingest(
        {
          ...ready,
          id: `ready-${index}`,
          occurredAt: new Date(now + index).toISOString(),
        },
        background
      )
    }
    expect(store.records()).toHaveLength(200)
    expect(store.records().at(-1)?.id).toBe("request-event")
    expect(store.records().some((record) => record.id === "ready-5")).toBe(
      false
    )
    expect(store.records()[0].id).toBe("ready-204")
  })

  it("still enforces the hard cap when all entries need attention", () => {
    const store = makeStore()
    for (let index = 0; index < 205; index++) {
      store.ingest(
        {
          ...request,
          id: `attention-${index}`,
          requestId: `request-${index}`,
          occurredAt: new Date(now + index).toISOString(),
        },
        background
      )
    }
    expect(store.records()).toHaveLength(200)
    expect(store.records().at(-1)?.id).toBe("attention-5")
  })
})
