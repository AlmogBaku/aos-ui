import { describe, expect, it, vi } from "vitest"

import {
  COALESCE_WINDOW_MS,
  PRESENCE_CLOSED_GRACE_MS,
  PRESENCE_GRACE_MS,
} from "../../protocol/push"
import type { ExecutionEvent } from "../core/events"
import type { RuntimeInstance } from "../core/runtime"
import type { SessionRow, SessionRows } from "../core/session-rows"
import { createPushDispatcher } from "./dispatcher"
import { createPresenceRegistry } from "./presence"
import type { PushRegistrations, StoredRegistration } from "./registrations"
import type { PushSendResult, PushSender } from "./sender"
import { createTestTimers } from "./test-utils/timers"

const START = 1_700_000_000_000
const OPERATOR = "operator"
const AGENT = "researcher"
const SESSION = "session-1"
const CONNECTION = "connection-1"

function device(
  suffix: string,
  overrides: Partial<StoredRegistration> = {}
): StoredRegistration {
  return {
    subscription: {
      endpoint: `https://push.example/${suffix}`,
      keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    },
    locale: "en",
    categories: { input: true, failure: true, completion: true },
    createdAt: new Date(START).toISOString(),
    ...overrides,
  }
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION,
    agentId: AGENT,
    title: "Notes",
    archived: false,
    updatedAt: new Date(START).toISOString(),
    status: "idle",
    ...overrides,
  }
}

function occurred(
  type: ExecutionEvent["type"],
  sessionId = SESSION,
  occurredAtMs = START
): ExecutionEvent {
  const base = {
    agentId: AGENT,
    sessionId,
    runId: "run-1",
    occurredAt: new Date(occurredAtMs).toISOString(),
  }
  if (type === "attention-requested")
    return { ...base, type, request: { id: "request-1", reason: "approval" } }
  if (type === "attention-resolved")
    return { ...base, type, interruptId: "request-1" }
  return { ...base, type }
}

type HarnessOptions = {
  devices?: StoredRegistration[]
  rows?: SessionRow[]
  send?: (target: unknown) => Promise<PushSendResult>
}

function harness(options: HarnessOptions = {}) {
  const clock = createTestTimers(START)
  const observers = new Set<(event: ExecutionEvent) => void>()
  const unobserve = vi.fn()
  const runtimeInstance = {
    sessions: {
      observe: vi.fn((listener: (event: ExecutionEvent) => void) => {
        observers.add(listener)
        return unobserve
      }),
    },
  } as unknown as RuntimeInstance

  const rows = new Map(
    (options.rows ?? []).map((row) => [`${row.agentId}\u0000${row.id}`, row])
  )
  const sessionRows = {
    get: (agentId: string, sessionId: string) =>
      rows.get(`${agentId}\u0000${sessionId}`),
  } as unknown as SessionRows

  const stored = [...(options.devices ?? [device("device-1")])]
  const registrations: PushRegistrations = {
    list: vi.fn(() => [...stored]),
    put: vi.fn(async () => undefined),
    remove: vi.fn(async (_principalId: string, endpoint: string) => {
      const index = stored.findIndex(
        (entry) => entry.subscription.endpoint === endpoint
      )
      if (index !== -1) stored.splice(index, 1)
    }),
  }

  const send = vi.fn(
    options.send ?? (async () => ({ result: "sent" }) as PushSendResult)
  )
  const sender: PushSender = { send }
  const presence = createPresenceRegistry({ now: clock.now })
  const logger = { info: vi.fn() }

  const dispatcher = createPushDispatcher({
    runtimeInstance,
    sessionRows,
    registrations,
    presence,
    sender,
    principalOf: () => OPERATOR,
    logger,
    now: clock.now,
    schedule: clock.schedule,
  })

  return {
    clock,
    dispatcher,
    presence,
    registrations,
    send,
    logger,
    unobserve,
    stored,
    publish(event: ExecutionEvent) {
      for (const observer of [...observers]) observer(event)
    },
  }
}

const lines = (logger: { info: ReturnType<typeof vi.fn> }) =>
  logger.info.mock.calls.map(([value]) => value)

describe("push dispatcher", () => {
  it("notifies only the devices that asked for the category", async () => {
    const test = harness({
      devices: [
        device("device-1"),
        device("device-2", {
          locale: "he",
          categories: { input: false, failure: true, completion: true },
        }),
      ],
    })

    test.publish(occurred("attention-requested"))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    const [target, message, urgency] = test.send.mock.calls[0]!
    expect(target).toMatchObject({
      subscription: { endpoint: "https://push.example/device-1" },
    })
    expect(message).toEqual({
      v: 1,
      category: "input",
      count: 1,
      agentId: AGENT,
      sessionId: SESSION,
      occurredAt: new Date(START + COALESCE_WINDOW_MS.input).toISOString(),
      locale: "en",
    })
    expect(urgency).toBe("high")
  })

  it("counts several Sessions into one push that names none of them", async () => {
    const test = harness()

    test.publish(occurred("attention-requested", "session-1"))
    test.publish(occurred("attention-requested", "session-2"))
    test.clock.advance(1_000)
    test.publish(occurred("attention-requested", "session-3"))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(test.send.mock.calls[0]![1]).toEqual({
      v: 1,
      category: "input",
      count: 3,
      occurredAt: new Date(START + COALESCE_WINDOW_MS.input).toISOString(),
      locale: "en",
    })
  })

  it("sends a finished run to every device at the slower cadence", async () => {
    const test = harness({ devices: [device("device-1"), device("device-2")] })

    test.publish(occurred("run-finished", "session-1"))
    test.publish(occurred("run-finished", "session-2"))
    test.clock.advance(COALESCE_WINDOW_MS.input)
    expect(test.send).not.toHaveBeenCalled()

    test.clock.advance(COALESCE_WINDOW_MS.completion)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledTimes(2))
    expect(test.send.mock.calls.map(([, , urgency]) => urgency)).toEqual([
      "normal",
      "normal",
    ])
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      category: "completion",
      count: 2,
    })
  })

  it("sends nothing while the operator is at the workspace", () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })

    test.publish(occurred("attention-requested"))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(0)
    expect(lines(test.logger)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "present",
        sessions: 1,
      },
    ])
  })

  it("notifies about an event that happened after the operator read the Session", async () => {
    // The closed-app case: the operator read the Session, then closed the tab,
    // and the turn finished afterwards. Nothing will ever report the row unread
    // again, so only the time the read settled can answer for this event.
    const test = harness({ rows: [row({ unread: false, readAt: START })] })

    test.publish(occurred("run-finished", SESSION, START + 1_000))
    test.clock.advance(COALESCE_WINDOW_MS.completion)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      category: "completion",
      count: 1,
      sessionId: SESSION,
    })
  })

  it("leaves out a Session the operator read after the event", () => {
    const test = harness({
      rows: [row({ unread: false, readAt: START + 2_000 })],
    })

    test.publish(occurred("attention-requested", SESSION, START + 1_000))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(0)
    expect(lines(test.logger)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "read",
        sessions: 1,
      },
    ])
  })

  it("leaves out a Session that is on screen, even behind an idle reader", async () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: SESSION,
      foreground: true,
      idle: true,
    })

    test.publish(occurred("attention-requested", SESSION))
    test.publish(occurred("attention-requested", "session-2"))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      count: 1,
      sessionId: "session-2",
    })
  })

  it("reports a window emptied by the Session on screen as exposed", () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: SESSION,
      foreground: true,
      idle: true,
    })

    test.publish(occurred("attention-requested", SESSION))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(lines(test.logger)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "exposed",
        sessions: 1,
      },
    ])
    const line = JSON.stringify(lines(test.logger))
    expect(line).not.toContain(SESSION)
    expect(line).not.toContain(AGENT)
    expect(line).not.toContain("push.example")
  })

  it("waits out the full grace of an operator who is only away", async () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    // The grace runs from the lapse, not from the last heartbeat before it.
    const lapsedAt = START + 30_000
    test.clock.advance(30_000)
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: false,
      idle: false,
    })

    test.publish(occurred("attention-requested"))
    test.clock.advance(COALESCE_WINDOW_MS.input)
    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(1)

    test.clock.advance(PRESENCE_CLOSED_GRACE_MS)
    expect(test.send).not.toHaveBeenCalled()
    test.clock.advance(PRESENCE_GRACE_MS)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      occurredAt: new Date(lapsedAt + PRESENCE_GRACE_MS).toISOString(),
    })
  })

  it("waits only long enough for a reconnect once every connection has gone", async () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    test.publish(occurred("attention-requested"))

    const closedAt = START + 2_000
    test.clock.advance(2_000)
    test.presence.clear(OPERATOR, CONNECTION)
    test.clock.advance(1_000)
    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(1)

    test.clock.advance(PRESENCE_CLOSED_GRACE_MS)

    await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce())
    expect(test.send.mock.calls[0]![1]).toMatchObject({
      occurredAt: new Date(closedAt + PRESENCE_CLOSED_GRACE_MS).toISOString(),
    })
  })

  it("sends nothing when a reload reconnects inside the closed grace", () => {
    const test = harness()
    test.presence.set(OPERATOR, CONNECTION, {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    test.publish(occurred("attention-requested"))
    test.presence.clear(OPERATOR, CONNECTION)

    // The reloaded page opens a new connection and reports itself present again.
    test.clock.advance(1_000)
    test.presence.set(OPERATOR, "connection-2", {
      sessionId: null,
      foreground: true,
      idle: false,
    })
    test.clock.advance(COALESCE_WINDOW_MS.input)

    expect(test.send).not.toHaveBeenCalled()
    expect(test.clock.pending()).toBe(0)
    expect(lines(test.logger)).toEqual([
      {
        event: "push.suppressed",
        category: "input",
        reason: "present",
        sessions: 1,
      },
    ])
  })

  it("forgets a device the push service reports as gone", async () => {
    const test = harness({
      devices: [device("device-1"), device("device-2")],
      send: async (target) =>
        (target as StoredRegistration).subscription.endpoint.endsWith(
          "device-2"
        )
          ? { result: "gone", status: 410 }
          : { result: "sent" },
    })

    test.publish(occurred("run-failed"))
    test.clock.advance(COALESCE_WINDOW_MS.failure)

    await vi.waitFor(() =>
      expect(test.registrations.remove).toHaveBeenCalledWith(
        OPERATOR,
        "https://push.example/device-2"
      )
    )
    expect(
      test.stored.map(({ subscription }) => subscription.endpoint)
    ).toEqual(["https://push.example/device-1"])
    expect(lines(test.logger)).toEqual([
      {
        event: "push.dispatched",
        category: "failure",
        count: 1,
        devices: 2,
        sent: 1,
        gone: 1,
        failed: 0,
        statuses: { "410": 1 },
      },
    ])
  })

  it("writes a line that names no device and no Session", async () => {
    const test = harness()

    test.publish(occurred("attention-requested"))
    test.clock.advance(COALESCE_WINDOW_MS.input)

    await vi.waitFor(() => expect(test.logger.info).toHaveBeenCalledOnce())
    const line = JSON.stringify(lines(test.logger))
    expect(line).not.toContain("push.example")
    expect(line).not.toContain("p256dh")
    expect(line).not.toContain(SESSION)
    expect(line).not.toContain(AGENT)
  })

  it("ignores the events no device is notified about", async () => {
    const test = harness()

    test.publish(occurred("run-started"))
    test.publish(occurred("attention-resolved"))
    test.clock.advance(60_000)

    expect(test.clock.pending()).toBe(0)
    expect(test.send).not.toHaveBeenCalled()
  })

  it("stops observing the coordinator when it closes", () => {
    const test = harness()
    test.publish(occurred("attention-requested"))

    test.dispatcher.close()

    expect(test.unobserve).toHaveBeenCalledOnce()
    test.clock.advance(60_000)
    expect(test.send).not.toHaveBeenCalled()
  })
})
