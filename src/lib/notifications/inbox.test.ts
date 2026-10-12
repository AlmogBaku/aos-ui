import { describe, expect, it } from "vitest"

import type { SessionMetadata } from "@/runtime-adapters/contracts"

import type { ActivityRecord } from "./activity"
import { buildInbox } from "./inbox"

const agents = [
  { id: "travel", name: "Travel Planner", avatar: "ring/blue" },
  { id: "ledger", name: "Ledger", avatar: "disc/rose" },
  { id: "draft:interview", name: "New Agent" },
]
const titles = new Map([
  ["lisbon", "Lisbon trip in May"],
  ["hotels", "Hotel shortlist"],
  ["invoices", "Q3 invoice export"],
])
const session = (
  sessionId: string,
  agentId: string,
  status: SessionMetadata["status"],
  updatedAt: string
): SessionMetadata => ({ sessionId, agentId, status, updatedAt, unread: true })
const record = (
  id: string,
  sessionId: string,
  agentId: string,
  type: "turn-finished" | "turn-failed",
  occurredAt: string
): ActivityRecord =>
  ({
    id,
    sessionId,
    agentId,
    type,
    occurredAt,
    turnId: id,
    resolved: false,
    browserDeliveredAt: null,
    read: false,
  }) as ActivityRecord

/** Each row as `sessionId state time`, the facts the inbox decides. */
const summary = (rows: { sessionId: string; state: string; time: string }[]) =>
  rows.map(({ sessionId, state, time }) => `${sessionId} ${state} ${time}`)

describe("buildInbox", () => {
  it.each([
    [
      "an unread Session the tab saw no record for keeps its own status and time",
      [session("hotels", "travel", "idle", "2026-09-04T18:40:00Z")],
      [],
      { waiting: [], unread: ["hotels unread 2026-09-04T18:40:00Z"] },
    ],
    [
      "a Session with several records is listed once, by its newest",
      [session("invoices", "ledger", "idle", "2026-09-05T09:00:00Z")],
      [
        record(
          "finished",
          "invoices",
          "ledger",
          "turn-finished",
          "2026-09-05T10:00:00Z"
        ),
        record(
          "failed",
          "invoices",
          "ledger",
          "turn-failed",
          "2026-09-05T11:00:00Z"
        ),
        // Another Agent's record never speaks for this Session.
        record(
          "stale",
          "invoices",
          "travel",
          "turn-finished",
          "2026-09-05T11:30:00Z"
        ),
      ],
      { waiting: [], unread: ["invoices failed 2026-09-05T11:00:00Z"] },
    ],
    [
      "waiting Sessions group first, each group newest first",
      [
        session("hotels", "travel", "idle", "2026-09-05T08:00:00Z"),
        session(
          "lisbon",
          "travel",
          "waiting-for-input",
          "2026-09-05T11:58:00Z"
        ),
        session("invoices", "ledger", "failed", "2026-09-05T11:00:00Z"),
      ],
      [],
      {
        waiting: ["lisbon waiting 2026-09-05T11:58:00Z"],
        unread: [
          "invoices failed 2026-09-05T11:00:00Z",
          "hotels unread 2026-09-05T08:00:00Z",
        ],
      },
    ],
  ])("%s", (_rule, sessions, records, expected) => {
    const inbox = buildInbox({ sessions, records, ready: [], agents, titles })
    expect({
      waiting: summary(inbox.waiting),
      unread: summary(inbox.unread),
    }).toEqual(expected)
  })

  it("gives a waiting row the question its newest request asks, and only a waiting row", () => {
    const asked = (
      id: string,
      sessionId: string,
      occurredAt: string,
      preview: { requestText?: string; requestMore?: number }
    ) =>
      ({
        ...record(id, sessionId, "travel", "turn-finished", occurredAt),
        type: "attention-requested",
        attentionKind: "question",
        requestId: id,
        ...preview,
      }) as ActivityRecord
    const inbox = buildInbox({
      sessions: [
        session(
          "lisbon",
          "travel",
          "waiting-for-input",
          "2026-09-05T09:00:00Z"
        ),
        session("hotels", "travel", "idle", "2026-09-05T09:00:00Z"),
      ],
      records: [
        asked("dates", "lisbon", "2026-09-05T10:00:00Z", {
          requestText: "Which dates work for you?",
        }),
        asked("fare", "lisbon", "2026-09-05T11:00:00Z", {
          requestText: "Book the refundable fare?",
          requestMore: 2,
        }),
        // Answered, so the Session is no longer waiting on it.
        asked("rooms", "hotels", "2026-09-05T11:00:00Z", {
          requestText: "How many rooms?",
        }),
      ],
      ready: [],
      agents,
      titles,
    })
    expect(inbox.waiting.map(({ request }) => request)).toEqual([
      { text: "Book the refundable fare?", more: 2 },
    ])
    expect(inbox.unread.map(({ request }) => request)).toEqual([undefined])
  })

  it("draws a creator Session as the rail's draft, and names each row", () => {
    const inbox = buildInbox({
      sessions: [
        session(
          "interview",
          "draft:interview",
          "waiting-for-input",
          "2026-09-05T11:00:00Z"
        ),
        session("lisbon", "travel", "idle", "2026-09-05T10:00:00Z"),
      ],
      records: [],
      ready: [],
      agents,
      titles,
    })
    expect([...inbox.waiting, ...inbox.unread]).toEqual([
      {
        key: "interview",
        agentId: "draft:interview",
        sessionId: "interview",
        agent: { id: "draft:interview", name: "New Agent" },
        title: undefined,
        state: "waiting",
        time: "2026-09-05T11:00:00Z",
      },
      {
        key: "lisbon",
        agentId: "travel",
        sessionId: "lisbon",
        agent: { id: "travel", name: "Travel Planner", avatar: "ring/blue" },
        title: "Lisbon trip in May",
        state: "unread",
        time: "2026-09-05T10:00:00Z",
      },
    ])
  })
})
