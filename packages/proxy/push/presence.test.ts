import { describe, expect, it } from "vitest"

import { PRESENCE_HEARTBEAT_MS } from "../../protocol/push"
import { createPresenceRegistry } from "./presence"

const OPERATOR = "operator"
const OTHER = "operator-2"
const SESSION = "session-1"
const OTHER_SESSION = "session-2"
const START = 1_700_000_000_000

function clock() {
  let value = START
  return {
    now: () => value,
    advance(ms: number) {
      value += ms
    },
  }
}

function registry() {
  const time = clock()
  return { time, presence: createPresenceRegistry({ now: time.now }) }
}

const active = { sessionId: SESSION, foreground: true, idle: false }

describe("workspace presence registry", () => {
  it("counts a foreground, active connection as present at its Session", () => {
    const { presence } = registry()

    presence.set(OPERATOR, "connection-1", active)

    expect(presence.present(OPERATOR)).toBe(true)
    expect(presence.exposed(OPERATOR, SESSION)).toBe(true)
    expect(presence.exposed(OPERATOR, OTHER_SESSION)).toBe(false)
  })

  it("keeps an idle connection's Session exposed while presence lapses", () => {
    const { presence } = registry()

    presence.set(OPERATOR, "connection-1", { ...active, idle: true })

    expect(presence.present(OPERATOR)).toBe(false)
    expect(presence.exposed(OPERATOR, SESSION)).toBe(true)
  })

  it("exposes nothing from a background connection", () => {
    const { presence } = registry()

    presence.set(OPERATOR, "connection-1", { ...active, foreground: false })

    expect(presence.present(OPERATOR)).toBe(false)
    expect(presence.exposed(OPERATOR, SESSION)).toBe(false)
  })

  it("drops a report that missed two heartbeats", () => {
    const { time, presence } = registry()
    presence.set(OPERATOR, "connection-1", active)

    time.advance(2 * PRESENCE_HEARTBEAT_MS)
    expect(presence.present(OPERATOR)).toBe(true)
    expect(presence.exposed(OPERATOR, SESSION)).toBe(true)

    time.advance(1_000)
    expect(presence.present(OPERATOR)).toBe(false)
    expect(presence.exposed(OPERATOR, SESSION)).toBe(false)
  })

  it("remembers when presence last held, after it stops holding", () => {
    const { time, presence } = registry()
    expect(presence.lastPresentAt(OPERATOR)).toBeUndefined()

    presence.set(OPERATOR, "connection-1", active)
    expect(presence.lastPresentAt(OPERATOR)).toBe(START)

    time.advance(PRESENCE_HEARTBEAT_MS)
    presence.set(OPERATOR, "connection-1", { ...active, idle: true })
    expect(presence.present(OPERATOR)).toBe(false)
    expect(presence.lastPresentAt(OPERATOR)).toBe(START)

    time.advance(PRESENCE_HEARTBEAT_MS)
    presence.set(OPERATOR, "connection-1", active)
    presence.clear(OPERATOR, "connection-1")
    expect(presence.lastPresentAt(OPERATOR)).toBe(
      START + 2 * PRESENCE_HEARTBEAT_MS
    )
  })

  it("forgets one closed connection and keeps the principal's others", () => {
    const { presence } = registry()
    presence.set(OPERATOR, "connection-1", active)
    presence.set(OPERATOR, "connection-2", {
      ...active,
      sessionId: OTHER_SESSION,
    })

    presence.clear(OPERATOR, "connection-1")

    expect(presence.present(OPERATOR)).toBe(true)
    expect(presence.exposed(OPERATOR, SESSION)).toBe(false)
    expect(presence.exposed(OPERATOR, OTHER_SESSION)).toBe(true)

    presence.clear(OPERATOR, "connection-2")
    expect(presence.present(OPERATOR)).toBe(false)
  })

  it("keeps one principal's presence out of another's", () => {
    const { presence } = registry()

    presence.set(OPERATOR, "connection-1", active)

    expect(presence.present(OTHER)).toBe(false)
    expect(presence.exposed(OTHER, SESSION)).toBe(false)
    expect(presence.lastPresentAt(OTHER)).toBeUndefined()
  })
})
