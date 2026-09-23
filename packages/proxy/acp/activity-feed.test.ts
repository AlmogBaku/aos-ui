import { describe, expect, it, vi } from "vitest"

import type { Session } from "../../protocol"
import type { AosActivityNotification } from "../../protocol/acp"
import type { ExecutionEvent, PendingRequest } from "../core/events"
import type { RuntimeInstance } from "../core/runtime"
import { createSessionRows } from "../core/session-rows"
import { createActivityFeed } from "./activity-feed"

const AGENT = "researcher"
const AT = "2026-09-19T10:00:00.000Z"

type Execution = {
  state: string
  turnId?: string
  requests: PendingRequest[]
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    agentId: AGENT,
    title: "Weekly digest",
    archived: false,
    updatedAt: AT,
    status: "idle",
    ...overrides,
  }
}

function harness(
  options: {
    sessions?: Session[]
    executions?: Record<string, Execution>
    now?: () => number
    limit?: number
    maxAgeMs?: number
  } = {}
) {
  let deliver: ((event: ExecutionEvent) => void) | undefined
  const unobserve = vi.fn()
  const listAllSessions = vi.fn(async () => ({
    sessions: options.sessions ?? [],
    total: options.sessions?.length ?? 0,
    limit: 100,
    offset: 0,
  }))
  // The coordinator and the runtime are wide shared surfaces; the feed reads
  // only the observer, the execution snapshot, and one catalog page.
  const runtimeInstance = {
    id: "hermes-primary",
    runtime: {
      listAllSessions,
      resolveSessionId: (_agentId: string, publicId: string) =>
        `stored-${publicId}`,
    },
    sessions: {
      observe: (listener: (event: ExecutionEvent) => void) => {
        deliver = listener
        return unobserve
      },
      snapshot: ({ sessionId }: { sessionId: string }) =>
        options.executions?.[sessionId] ?? { state: "idle", requests: [] },
    },
  } as unknown as RuntimeInstance
  const sessionRows = createSessionRows()
  const feed = createActivityFeed({
    runtimeInstance,
    sessionRows,
    ...(options.now ? { now: options.now } : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  })
  return {
    feed,
    sessionRows,
    unobserve,
    deliver: (event: ExecutionEvent) => deliver?.(event),
  }
}

function lifecycle(
  kind: "turn-started" | "turn-finished" | "turn-failed",
  turnId: string,
  occurredAt = AT
): ExecutionEvent {
  return { agentId: AGENT, sessionId: "session-1", turnId, occurredAt, kind }
}

describe("createActivityFeed", () => {
  it("hydrates unread rows, pending attention, and failed turns", async () => {
    const { feed, sessionRows } = harness({
      sessions: [
        session({ id: "session-1", unread: true }),
        session({ id: "session-2", status: "waiting-for-input" }),
        session({ id: "session-3", status: "failed" }),
        session({ id: "session-4", status: "failed" }),
        session({ id: "session-5" }),
      ],
      executions: {
        "stored-session-2": {
          state: "waiting-for-input",
          turnId: "run-2",
          requests: [
            { requestId: "approval-1", kind: "permission" },
            { requestId: "question-1", kind: "elicitation" },
          ],
        },
        "stored-session-3": { state: "idle", turnId: "run-3", requests: [] },
      },
    })

    await vi.waitFor(() => expect(feed.snapshot()).toHaveLength(5))

    expect(feed.snapshot()).toEqual([
      expect.objectContaining({
        type: "unread-changed",
        agentId: AGENT,
        sessionId: "session-1",
        unread: true,
      }),
      expect.objectContaining({
        type: "attention-requested",
        sessionId: "session-2",
        requestId: "approval-1",
        attentionKind: "permission",
      }),
      expect.objectContaining({
        type: "attention-requested",
        sessionId: "session-2",
        requestId: "question-1",
        attentionKind: "question",
      }),
      expect.objectContaining({
        type: "turn-failed",
        sessionId: "session-3",
        turnId: "run-3",
      }),
      expect.objectContaining({
        type: "turn-failed",
        sessionId: "session-4",
        turnId: "session-4",
      }),
    ])
    expect(sessionRows.get(AGENT, "session-1")?.unread).toBe(true)
  })

  it("publishes live execution events and every unread flip", async () => {
    const { deliver, feed, sessionRows } = harness({
      sessions: [session({ unread: true })],
    })
    await vi.waitFor(() => expect(feed.snapshot()).toHaveLength(1))
    const seen: AosActivityNotification[] = []
    const unsubscribe = feed.subscribe((event) => seen.push(event))

    deliver(lifecycle("turn-started", "run-1"))
    deliver({
      agentId: AGENT,
      sessionId: "session-1",
      turnId: "run-1",
      occurredAt: AT,
      kind: "attention-requested",
      request: { requestId: "approval-1", kind: "permission" },
    })
    deliver({
      agentId: AGENT,
      sessionId: "session-1",
      turnId: "run-1",
      occurredAt: AT,
      kind: "attention-resolved",
      requestId: "approval-1",
    })
    deliver(lifecycle("turn-finished", "run-1"))
    sessionRows.rememberList([session({ unread: false })])
    sessionRows.rememberList([session({ title: "Renamed", unread: false })])

    expect(seen).toEqual([
      expect.objectContaining({ type: "turn-started", turnId: "run-1" }),
      expect.objectContaining({
        type: "attention-requested",
        requestId: "approval-1",
        attentionKind: "permission",
      }),
      expect.objectContaining({
        type: "attention-resolved",
        requestId: "approval-1",
      }),
      expect.objectContaining({ type: "turn-finished", turnId: "run-1" }),
      expect.objectContaining({ type: "unread-changed", unread: false }),
    ])

    unsubscribe()
    sessionRows.rememberList([session({ unread: true })])
    expect(seen).toHaveLength(5)
    expect(feed.snapshot()).toHaveLength(7)
  })

  it("keeps only the newest events inside the age window", () => {
    let clock = Date.parse(AT)
    const { deliver, feed } = harness({
      now: () => clock,
      limit: 3,
      maxAgeMs: 10_000,
    })

    for (const turnId of ["run-1", "run-2", "run-3", "run-4"])
      deliver(lifecycle("turn-started", turnId, new Date(clock).toISOString()))

    expect(
      feed.snapshot().map((event) => "turnId" in event && event.turnId)
    ).toEqual(["run-2", "run-3", "run-4"])

    clock += 20_000
    deliver(lifecycle("turn-started", "run-5", new Date(clock).toISOString()))

    expect(
      feed.snapshot().map((event) => "turnId" in event && event.turnId)
    ).toEqual(["run-5"])
  })

  it("stops observing and publishing after close", async () => {
    const { deliver, feed, sessionRows, unobserve } = harness({
      sessions: [session({ unread: true })],
    })
    await vi.waitFor(() => expect(feed.snapshot()).toHaveLength(1))
    const seen: AosActivityNotification[] = []
    feed.subscribe((event) => seen.push(event))

    feed.close()
    deliver(lifecycle("turn-started", "run-1"))
    sessionRows.rememberList([session({ unread: false })])

    expect(unobserve).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([])
    expect(feed.snapshot()).toHaveLength(1)
  })
})
