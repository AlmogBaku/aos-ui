import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { fromPromise } from "xstate"

import { defaultClock } from "./clock"
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
    { level: "debug", event: "join", state: "joining" },
    { level: "debug", event: "joined", state: "joined" },
  ])
})
