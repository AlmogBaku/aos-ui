import { describe, expect, it, vi } from "vitest"

import type { Session } from "../../protocol"
import { createSessionRows, READ_GUARD_MS } from "./session-rows"

const AGENT = "researcher"
const SESSION = "session-1"

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    agentId: AGENT,
    title: "Weekly digest",
    archived: false,
    updatedAt: "2026-09-19T10:00:00.000Z",
    status: "idle",
    ...overrides,
  }
}

describe("createSessionRows", () => {
  it("applies unread from a list page and returns only what changed", () => {
    const rows = createSessionRows()

    expect(rows.rememberList([session({ unread: true })])).toEqual([
      expect.objectContaining({ id: SESSION, unread: true }),
    ])
    expect(rows.get(AGENT, SESSION)?.unread).toBe(true)
    expect(rows.rememberList([session({ unread: true })])).toEqual([])
    expect(rows.rememberList([session({ unread: false })])).toEqual([
      expect.objectContaining({ unread: false }),
    ])
  })

  it("keeps a known unread value through every detail read", () => {
    const rows = createSessionRows()
    rows.rememberList([session({ unread: true })])

    const renamed = rows.rememberDetail(session({ title: "Renamed" }))

    expect(renamed.title).toBe("Renamed")
    expect(renamed.unread).toBe(true)
    expect(rows.rememberDetail(session({ unread: false })).unread).toBe(true)
    expect(rows.get(AGENT, SESSION)?.unread).toBe(true)
  })

  it("leaves unread absent while no read has reported it", () => {
    const rows = createSessionRows()

    const remembered = rows.rememberDetail(session())

    expect(remembered).not.toHaveProperty("unread")
    expect(rows.rememberList([session()])).toEqual([])
  })

  it("ignores a stale unread page inside the write guard and honors it after", () => {
    let clock = 1_000
    const rows = createSessionRows({ now: () => clock })
    rows.rememberList([session({ unread: true })])

    expect(rows.markRead(AGENT, SESSION)?.unread).toBe(false)

    expect(rows.rememberList([session({ unread: true })])).toEqual([])
    expect(rows.get(AGENT, SESSION)?.unread).toBe(false)

    clock += READ_GUARD_MS + 1
    expect(rows.rememberList([session({ unread: true })])).toEqual([
      expect.objectContaining({ unread: true }),
    ])
    expect(rows.get(AGENT, SESSION)?.unread).toBe(true)
  })

  it("reports an unknown Session as unknown and forgets a known one", () => {
    const rows = createSessionRows()

    expect(rows.markRead(AGENT, "missing")).toBeUndefined()

    rows.rememberList([session({ unread: true })])
    rows.forget(AGENT, SESSION)

    expect(rows.get(AGENT, SESSION)).toBeUndefined()
    expect(rows.rememberList([session({ unread: true })])).toEqual([
      expect.objectContaining({ unread: true }),
    ])
  })

  it("notifies subscribers once per changed row until they unsubscribe", () => {
    const rows = createSessionRows()
    const listener = vi.fn()
    const unsubscribe = rows.subscribe(listener)

    rows.rememberList([
      session({ unread: true }),
      session({ id: "session-2", unread: false }),
    ])
    expect(listener).toHaveBeenCalledTimes(2)

    listener.mockClear()
    rows.rememberList([session({ unread: true })])
    rows.rememberDetail(session({ unread: false }))
    expect(listener).not.toHaveBeenCalled()

    rows.rememberDetail(session({ title: "Renamed" }))
    rows.markRead(AGENT, SESSION)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    rows.rememberList([session({ title: "Again", unread: true })])
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
