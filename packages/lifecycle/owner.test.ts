import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { defaultClock } from "./clock"
import type { LogFields, Logger } from "./logger"
import { createOwner, ownerSetup } from "./owner"

type LogRecord = { level: string; message: string; fields: LogFields }

function recorder() {
  const records: LogRecord[] = []
  const logger = (bindings: LogFields): Logger => {
    const at = (level: string) => (fields: LogFields, message: string) => {
      records.push({ level, message, fields: { ...bindings, ...fields } })
    }
    return {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      child: (more) => logger({ ...bindings, ...more }),
    }
  }
  return { logger: logger({}), records }
}

/** idle → joining (join deadline 1 s) → joined, or expired at the deadline. */
function membership(logger: Logger) {
  return ownerSetup("membership", logger, defaultClock)
    .extend({ delays: { join: 1_000 } })
    .createMachine({
      context: { generation: 0 },
      initial: "idle",
      states: {
        idle: {
          on: { join: { target: "joining", actions: "bumpGeneration" } },
        },
        joining: { after: { join: "expired" }, on: { joined: "joined" } },
        joined: { meta: { log: "info" } },
        expired: {},
      },
    })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it("writes one line per transition with the deadline it arms or clears", () => {
  const { logger, records } = recorder()
  const owner = createOwner(membership(logger), {
    logger,
    clock: defaultClock,
    bindings: { sessionId: "session-1" },
  })

  owner.actor.send({ type: "join" })
  vi.advanceTimersByTime(250)
  owner.actor.send({ type: "joined" })

  expect(records).toEqual([
    {
      level: "debug",
      message: "membership.transition",
      fields: {
        sessionId: "session-1",
        from: "idle",
        to: "joining",
        generation: 1,
        event: "join",
        elapsedMs: 0,
        armedMs: 1_000,
      },
    },
    {
      level: "info",
      message: "membership.joined",
      fields: {
        sessionId: "session-1",
        from: "joining",
        to: "joined",
        generation: 1,
        event: "joined",
        elapsedMs: 250,
        clearedMs: 1_000,
      },
    },
  ])
})

it("fires after deadlines on the injected monotonic clock only", () => {
  const { logger } = recorder()
  const owner = createOwner(membership(logger), {
    logger,
    clock: defaultClock,
    bindings: {},
  })
  owner.actor.send({ type: "join" })
  const joinedAt = defaultClock.now()

  vi.setSystemTime(Date.now() + 60_000)
  expect(defaultClock.now()).toBe(joinedAt)
  expect(owner.actor.getSnapshot().value).toBe("joining")

  vi.advanceTimersByTime(999)
  expect(owner.actor.getSnapshot().value).toBe("joining")
  vi.advanceTimersByTime(1)
  expect(owner.actor.getSnapshot().value).toBe("expired")
})
