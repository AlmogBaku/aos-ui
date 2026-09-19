import { describe, expect, it } from "vitest"

import type {
  SessionMetadata,
  WorkspaceActivityEvent,
} from "@/runtime-adapters/contracts"
import { ActivityStore } from "./store"

const now = Date.parse("2026-09-05T12:00:00.000Z")
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
const sessions: SessionMetadata[] = [
  {
    threadId: "thread-1",
    agentId: "agent-1",
    updatedAt: new Date(now).toISOString(),
    status: "idle",
    unread: true,
  },
  {
    threadId: "thread-2",
    agentId: "agent-2",
    updatedAt: new Date(now).toISOString(),
    status: "idle",
    unread: false,
  },
]
const makeStore = (sessionState: readonly SessionMetadata[] = sessions) =>
  new ActivityStore({
    now: () => now,
    getThreadOwner: (threadId: string) =>
      ({ "thread-1": "agent-1", "thread-2": "agent-2" })[threadId],
    getSessions: () => sessionState,
  })

describe("Activity store", () => {
  it.each(["start", "terminal"] as const)(
    "expires abandoned %s bookkeeping after 30 days",
    (kind) => {
      let time = now
      const store = new ActivityStore({
        now: () => time,
        getThreadOwner: () => "agent-1",
        getSessions: () => sessions,
      })
      store.ingest(kind === "start" ? start : finish)
      time += 30 * 24 * 60 * 60 * 1000
      const freshTime = new Date(time).toISOString()
      const counterpart =
        kind === "start" ? { ...finish, occurredAt: freshTime } : start
      expect(store.ingest(counterpart)).toBeNull()
      expect(store.records()).toEqual([])
    }
  )

  it("retains early resolution and identity deduplication only for the 30-day window", () => {
    let time = now
    const store = new ActivityStore({
      now: () => time,
      getThreadOwner: () => "agent-1",
      getSessions: () => sessions,
    })
    store.ingest(resolution)
    time += 30 * 24 * 60 * 60 * 1000 - 1
    expect(
      store.ingest({
        ...ready,
        id: resolution.id,
        occurredAt: new Date(time).toISOString(),
      })
    ).toBeNull()
    time += 1
    expect(
      store.ingest({ ...request, occurredAt: new Date(time).toISOString() })
        ?.resolved
    ).toBe(false)
    expect(
      store.ingest({
        ...ready,
        id: resolution.id,
        occurredAt: new Date(time).toISOString(),
      })?.type
    ).toBe("agent-ready")
  })

  it("expires closed lifecycle bookkeeping with expired records", () => {
    let time = now
    const store = new ActivityStore({
      now: () => time,
      getThreadOwner: () => "agent-1",
      getSessions: () => sessions,
    })
    store.ingest(start)
    store.ingest(finish)
    time += 30 * 24 * 60 * 60 * 1000 + 1001
    const occurredAt = new Date(time).toISOString()
    store.ingest({ ...start, occurredAt })
    expect(store.ingest({ ...finish, occurredAt })?.id).toBe(finish.id)
  })

  it("reserves a buffered terminal's ID before a conflicting visible event arrives", () => {
    const store = makeStore()
    store.ingest(finish)
    expect(store.ingest({ ...ready, id: finish.id })).toBeNull()
    expect(store.ingest(start)?.type).toBe("run-finished")
    expect(store.records()[0]?.type).toBe("run-finished")
  })

  it.each(["read", "ingest"] as const)(
    "drops a superseded owner's entries before %s",
    (transition) => {
      const ownership: { owner?: string } = { owner: "agent-1" }
      const store = new ActivityStore({
        now: () => now,
        getThreadOwner: () => ownership.owner,
        getSessions: () => sessions,
      })
      store.ingest(ready)
      expect(store.records()).toHaveLength(1)
      ownership.owner = "agent-2"
      if (transition === "ingest")
        store.ingest({ ...ready, id: "correct-owner", agentId: "agent-2" })
      expect(store.records().map((record) => record.agentId)).toEqual(
        transition === "read" ? [] : ["agent-2"]
      )
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
        store.ingest(candidate)
      expect(store.ingest(start)?.id).toBe("finish-1")
      expect(store.records()[0]?.occurredAt).toBe("2026-09-05T12:00:01.000Z")
    }
  )

  it.each([start, finish, resolution])(
    "rejects cross-origin reuse of bookkeeping ID $id",
    (bookkeeping) => {
      const store = makeStore()
      store.ingest(bookkeeping)
      store.ingest({
        ...request,
        id: "agent-2-request",
        agentId: "agent-2",
        threadId: "thread-2",
      })
      store.ingest({
        ...resolution,
        id: bookkeeping.id,
        agentId: "agent-2",
        threadId: "thread-2",
      })
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
      store.ingest(bookkeeping)
      expect(store.ingest({ ...ready, id: bookkeeping.id })).toBeNull()
      expect(store.records()).toEqual([])
    }
  )

  it("rejects resolution ID reuse for another request at the same origin", () => {
    const store = makeStore()
    store.ingest(resolution)
    store.ingest({ ...request, requestId: "request-2" })
    store.ingest({ ...resolution, requestId: "request-2" })
    expect(store.records()[0]?.resolved).toBe(false)
  })

  it("rejects start ID reuse for another lifecycle at the same origin", () => {
    const store = makeStore()
    store.ingest(start)
    store.ingest({ ...start, lifecycleId: "run-2" })
    store.ingest({ ...finish, lifecycleId: "run-2" })
    expect(store.records()).toEqual([])
  })

  it("records terminal activation events without retaining caller-owned payloads", () => {
    const store = makeStore()
    const payload = {
      ...ready,
      message: "private-message",
      error: "private-error",
    }
    expect(store.ingest(payload)).toMatchObject({
      id: "ready-1",
      read: false,
      resolved: false,
    })
    payload.agentId = "changed"
    expect(store.records()).toEqual([
      { ...ready, read: false, resolved: false, browserDeliveredAt: null },
    ])
    const snapshot = store.records()
    snapshot[0].resolved = true
    expect(store.records()[0].resolved).toBe(false)
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
    expect(store.ingest(event)).toBeNull()
    expect(store.records()).toEqual([])
  })

  it("pairs a start and terminal exactly once without displaying the start", () => {
    const store = makeStore()
    expect(store.ingest(start)).toBeNull()
    expect(store.records()).toEqual([])
    expect(store.ingest(finish)?.type).toBe("run-finished")
    expect(store.ingest(finish)).toBeNull()
    expect(store.ingest({ ...finish, id: "duplicate-terminal" })).toBeNull()
    expect(store.records().map((record) => record.id)).toEqual(["finish-1"])
  })

  it("buffers a terminal until its observed start arrives out of order", () => {
    const store = makeStore()
    expect(store.ingest(finish)).toBeNull()
    expect(store.records()).toEqual([])
    expect(store.ingest(start)?.id).toBe("finish-1")
    expect(store.ingest(start)).toBeNull()
    expect(store.records()).toHaveLength(1)
  })

  it("does not pair lifecycles across Agents, Sessions, or IDs", () => {
    const store = makeStore()
    store.ingest(start)
    store.ingest({
      ...finish,
      id: "other-run-terminal",
      lifecycleId: "other-run",
    })
    store.ingest({
      ...finish,
      id: "other-session",
      agentId: "agent-2",
      threadId: "thread-2",
    })
    expect(store.records()).toEqual([])
    expect(store.ingest(finish)?.id).toBe("finish-1")
  })

  it("preserves the first valid failure when completion arrives before a delayed start", () => {
    const store = makeStore()
    store.ingest({ ...finish, id: "failure", type: "run-failed" })
    store.ingest({
      ...finish,
      id: "later-completion",
      occurredAt: "2026-09-05T12:00:02.000Z",
    })
    expect(store.ingest(start)?.type).toBe("run-failed")
    expect(store.records().map((record) => record.type)).toEqual(["run-failed"])
  })

  it("preserves the first valid completion when failure arrives before a delayed start", () => {
    const store = makeStore()
    store.ingest(finish)
    store.ingest({
      ...finish,
      id: "later-failure",
      type: "run-failed",
      occurredAt: "2026-09-05T12:00:02.000Z",
    })
    expect(store.ingest(start)?.type).toBe("run-finished")
  })

  it("corrects a duplicate terminal timestamp without moving its closing order", () => {
    const store = makeStore()
    store.ingest({
      ...finish,
      id: "failure",
      type: "run-failed",
      occurredAt: "2026-09-05T11:59:59.000Z",
    })
    store.ingest({
      ...finish,
      id: "later-completion",
      occurredAt: "2026-09-05T12:00:03.000Z",
    })
    store.ingest({ ...finish, id: "failure", type: "run-failed" })
    expect(store.ingest(start)?.type).toBe("run-failed")
  })

  it("pairs failures and prevents a later completion for the failed lifecycle", () => {
    const store = makeStore()
    store.ingest(start)
    expect(store.ingest({ ...finish, type: "run-failed" })?.type).toBe(
      "run-failed"
    )
    store.ingest({ ...finish, id: "late-finish" })
    expect(store.records().map((record) => record.type)).toEqual(["run-failed"])
  })

  it("rejects a terminal timestamp older than the observed start", () => {
    const store = makeStore()
    store.ingest(start)
    store.ingest({ ...finish, occurredAt: "2026-09-05T11:59:59.000Z" })
    expect(store.records()).toEqual([])
    expect(store.ingest(finish)?.id).toBe("finish-1")
  })

  it("preserves delivery bookkeeping across older duplicate events", () => {
    const store = makeStore()
    store.ingest(ready)
    store.markBrowserDelivered(ready.id, base.occurredAt)
    expect(
      store.ingest({ ...ready, occurredAt: "2026-09-04T12:00:00.000Z" })
    ).toBeNull()
    expect(store.records()).toEqual([
      {
        ...ready,
        read: false,
        resolved: false,
        browserDeliveredAt: base.occurredAt,
      },
    ])
  })

  it("rejects reuse of an event ID by another owned target", () => {
    const store = makeStore()
    store.ingest(ready)
    expect(
      store.ingest({ ...ready, agentId: "agent-2", threadId: "thread-2" })
    ).toBeNull()
    expect(store.records()[0].agentId).toBe("agent-1")
  })

  it("sorts out-of-order records newest first with stable ID ordering for ties", () => {
    const store = makeStore()
    store.ingest({ ...ready, id: "b", occurredAt: "2026-09-05T11:00:00.000Z" })
    store.ingest({ ...ready, id: "c" })
    store.ingest({ ...ready, id: "a" })
    expect(store.records().map((record) => record.id)).toEqual(["a", "c", "b"])
  })

  it("derives read state from provider Session state, never from arrival", () => {
    const store = makeStore()
    store.ingest(ready)
    store.ingest({
      ...ready,
      id: "other",
      agentId: "agent-2",
      threadId: "thread-2",
    })
    expect(store.records().map((record) => [record.id, record.read])).toEqual([
      ["other", true],
      ["ready-1", false],
    ])
  })

  it("treats every entry of a Session awaiting input as unread", () => {
    const store = makeStore([
      { ...sessions[0]!, unread: false },
      { ...sessions[1]!, status: "waiting-for-input" },
    ])
    store.ingest(ready)
    store.ingest({
      ...ready,
      id: "other",
      agentId: "agent-2",
      threadId: "thread-2",
    })
    expect(store.records().map((record) => [record.id, record.read])).toEqual([
      ["other", false],
      ["ready-1", true],
    ])
  })

  it("resolves only the matching attention request without creating a follow-up entry", () => {
    const store = makeStore()
    store.ingest(request)
    store.ingest({ ...request, id: "other-request", requestId: "request-2" })
    expect(store.ingest(resolution)).toBeNull()
    store.ingest(request)
    expect(
      store.records().map((record) => [record.id, record.resolved])
    ).toEqual([
      ["other-request", false],
      ["request-event", true],
    ])
  })

  it("remembers an early resolution without reopening a delayed attention event", () => {
    const store = makeStore()
    store.ingest(resolution)
    expect(store.ingest(request)?.resolved).toBe(true)
    expect(store.records()).toHaveLength(1)
  })

  it("never resolves a different origin sharing the request ID", () => {
    const store = makeStore()
    store.ingest(request)
    store.ingest({ ...resolution, agentId: "agent-2", threadId: "thread-2" })
    expect(store.records()[0].resolved).toBe(false)
  })

  it("marks a deleted target resolved while preserving its Activity entry", () => {
    const store = makeStore()
    store.ingest(request)
    store.markUnavailable(request.id)
    expect(store.records()[0]).toMatchObject({ id: request.id, resolved: true })
  })

  it("expires 30-day ordinary/resolved records while preserving unresolved attention", () => {
    const store = makeStore()
    const old = "2026-08-06T12:00:00.000Z"
    store.ingest({ ...request, occurredAt: old })
    store.ingest({ ...ready, occurredAt: old })
    store.ingest({
      ...ready,
      id: "recent",
      occurredAt: "2026-08-06T12:00:00.001Z",
    })
    expect(store.records().map((record) => record.id)).toEqual([
      "recent",
      "request-event",
    ])
    store.ingest(resolution)
    expect(store.records().map((record) => record.id)).toEqual(["recent"])
  })

  it("caps entries at 200, retaining old unresolved attention before ordinary entries", () => {
    const store = makeStore()
    store.ingest({ ...request, occurredAt: "2026-07-01T00:00:00.000Z" })
    for (let index = 0; index < 205; index++) {
      store.ingest({
        ...ready,
        id: `ready-${index}`,
        occurredAt: new Date(now + index).toISOString(),
      })
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
      store.ingest({
        ...request,
        id: `attention-${index}`,
        requestId: `request-${index}`,
        occurredAt: new Date(now + index).toISOString(),
      })
    }
    expect(store.records()).toHaveLength(200)
    expect(store.records().at(-1)?.id).toBe("attention-5")
  })
})
