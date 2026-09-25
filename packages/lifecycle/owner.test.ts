import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { fromPromise } from "xstate"

import { defaultClock, type Clock } from "./clock"
import { inspectToLogger, type LogFields, type Logger } from "./logger"
import { createOwner, fromAbortable, ownerSetup } from "./owner"

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

/** A Clock whose timers fire only when the test advances it. */
function manualClock() {
  let now = 0
  let lastId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => {
      timers.set(++lastId, { at: now + ms, callback })
      return lastId
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number)
    },
    advance(ms: number) {
      now += ms
      for (const [id, { at, callback }] of timers)
        if (at <= now) {
          timers.delete(id)
          callback()
        }
    },
  }
}

/**
 * idle → joining → joined, or expired at the 1 s join deadline. While joining,
 * the request retries after a drawn 300-599 ms, each retry a new generation.
 */
function membership(logger: Logger, clock: Clock = defaultClock) {
  return ownerSetup("membership", logger, clock)
    .extend({
      delays: {
        join: 1_000,
        retry: () => 300 + Math.floor(Math.random() * 300),
      },
    })
    .createMachine({
      context: { generation: 0 },
      initial: "idle",
      states: {
        idle: {
          on: { join: { target: "joining", actions: "bumpGeneration" } },
        },
        joining: {
          after: { join: "expired" },
          on: { joined: "joined" },
          initial: "requesting",
          states: {
            requesting: {
              after: {
                retry: {
                  target: "requesting",
                  reenter: true,
                  actions: "bumpGeneration",
                },
              },
            },
          },
        },
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

it("writes one line per transition with the deadlines it arms and clears", () => {
  const { logger, records } = recorder()
  vi.spyOn(Math, "random").mockReturnValue(0)
  const owner = createOwner(membership(logger), {
    logger,
    clock: defaultClock,
    bindings: { sessionId: "session-1" },
  })

  owner.actor.send({ type: "join" })
  vi.advanceTimersByTime(350)
  owner.actor.send({ type: "joined" })

  const line = { level: "debug", message: "membership.transition" }
  const joining = { sessionId: "session-1", to: "joining.requesting" }
  expect(records).toEqual([
    {
      ...line,
      fields: {
        ...joining,
        from: "idle",
        generation: 1,
        event: "join",
        elapsedMs: 0,
        armed: [1_000, "retry"],
      },
    },
    {
      ...line,
      fields: {
        ...joining,
        from: "joining.requesting",
        generation: 2,
        event: "xstate.after.retry.membership.joining.requesting",
        elapsedMs: 300,
        armed: ["retry"],
      },
    },
    {
      level: "info",
      message: "membership.joined",
      fields: {
        sessionId: "session-1",
        from: "joining.requesting",
        to: "joined",
        generation: 2,
        event: "joined",
        elapsedMs: 50,
        cleared: ["retry", 1_000],
      },
    },
  ])
})

it("fires after deadlines on the injected clock alone, drawing each once", () => {
  const { logger } = recorder()
  const clock = manualClock()
  vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5)
  const owner = createOwner(membership(logger, clock), {
    logger,
    clock,
    bindings: {},
  })
  owner.actor.send({ type: "join" })

  vi.advanceTimersByTime(60_000)
  clock.advance(299)
  expect(owner.generation).toBe(1)
  clock.advance(1)
  expect(owner.generation).toBe(2)
  clock.advance(449)
  expect(owner.generation).toBe(2)
  clock.advance(1)
  expect(owner.generation).toBe(3)
  clock.advance(249)
  expect(owner.actor.getSnapshot().value).toEqual({ joining: "requesting" })
  clock.advance(1)
  expect(owner.actor.getSnapshot().value).toBe("expired")
})

it.each(["dispose", "a final state", "a thrown action"] as const)(
  "releases the owner exactly once after %s and stops its children",
  (exit) => {
    const { logger } = recorder()
    let child: AbortSignal | undefined
    const machine = ownerSetup("turn", logger, defaultClock).createMachine({
      context: { generation: 0 },
      initial: "running",
      states: {
        running: {
          invoke: {
            src: fromPromise(({ signal }) => {
              child = signal
              return new Promise(() => {})
            }),
          },
          on: {
            settle: "settled",
            fail: {
              actions: () => {
                throw new Error("synthetic failure")
              },
            },
          },
        },
        settled: { type: "final" },
      },
    })
    const owner = createOwner(machine, {
      logger,
      clock: defaultClock,
      bindings: {},
    })
    let released = 0
    owner.stack.defer(() => {
      released += 1
    })

    if (exit === "dispose") owner.dispose()
    if (exit === "a final state") owner.actor.send({ type: "settle" })
    if (exit === "a thrown action") owner.actor.send({ type: "fail" })

    expect(released).toBe(1)
    expect(child?.aborted).toBe(true)
    owner.dispose()
    expect(released).toBe(1)
  }
)

it("aborts an invoke when its state exits and ignores its late result", async () => {
  const { logger } = recorder()
  const attempts: { signal: AbortSignal; resolve: () => void }[] = []
  const machine = ownerSetup("link", logger, defaultClock).createMachine({
    context: { generation: 0 },
    initial: "connecting",
    states: {
      connecting: {
        invoke: {
          src: fromAbortable(
            (signal) =>
              new Promise<void>((resolve) => attempts.push({ signal, resolve }))
          ),
          onDone: "ready",
        },
        on: {
          lost: {
            target: "connecting",
            reenter: true,
            actions: "bumpGeneration",
          },
        },
      },
      ready: {},
    },
  })
  const owner = createOwner(machine, {
    logger,
    clock: defaultClock,
    bindings: {},
  })
  const first = owner.generation

  owner.actor.send({ type: "lost" })
  expect(attempts.map(({ signal }) => signal.aborted)).toEqual([true, false])

  attempts[0]!.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(owner.actor.getSnapshot().value).toBe("connecting")
  expect(owner.stale(first)).toBe(true)
  expect(owner.stale(owner.generation)).toBe(false)

  owner.dispose()
  expect(owner.stale(owner.generation)).toBe(true)
})

it("writes one inspection line per transition taken when inspected", () => {
  const { logger, records } = recorder()
  const owner = createOwner(membership(logger), {
    logger,
    clock: defaultClock,
    inspect: inspectToLogger(logger),
    bindings: {},
  })

  owner.actor.send({ type: "join" })
  owner.actor.send({ type: "unhandled" })
  owner.actor.send({ type: "joined" })
  owner.dispose()

  expect(
    records
      .filter(({ message }) => message === "xstate.transition")
      .map(({ level, fields: { event, state } }) => ({ level, event, state }))
  ).toEqual([
    { level: "debug", event: "join", state: { joining: "requesting" } },
    { level: "debug", event: "joined", state: "joined" },
  ])
})
