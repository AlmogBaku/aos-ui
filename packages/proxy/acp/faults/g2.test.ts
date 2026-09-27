import { methods } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import { AOS_METHODS } from "../../../protocol/acp"
import { useFakeClock } from "../../../../test/support/fake-clock"
import { assertLeakFree } from "../../../../test/support/leak-oracle"
import { PendingRequestKind, TurnEventKind } from "../../core/events"
import { ServerSessionNotFoundError } from "../../core/runtime"
import {
  chunk,
  harness,
  open,
  prompt,
  said,
  SESSION,
  turnStarted,
  type Recorded,
} from "../test-harness"

type Test = Awaited<ReturnType<typeof harness>>

const gone = () => new ServerSessionNotFoundError()

const notice = (entry: Recorded) => entry.method === AOS_METHODS.notify.error

/** Every read the Session's readings took. */
const reads = (test: Test) =>
  test.logs
    .records()
    .filter(
      ({ message, fields }) =>
        message === "reading.transition" &&
        fields.sessionId === SESSION &&
        fields.to === "reading"
    ).length

/** A turn `test` started, which every member follows. */
async function running(test: Test, members: readonly Test[]) {
  await prompt(test, "Summarize")
  test.sources[0]?.emit(turnStarted())
  chunk(test.sources[0], "Live")
  for (const { recorder } of members)
    await recorder.wait(said("Live"), "an update carrying Live")
}

/**
 * Each Session command, failing as the provider finds its Session gone, on a
 * turn every member follows when it acts on one. A command with an answer
 * answers not found; a stop and an answer to the provider's own request have
 * none to give.
 */
const COMMANDS: {
  command: string
  live?: true
  fail(test: Test): Promise<void>
}[] = [
  {
    command: "send",
    async fail(test) {
      test.faults.failOnce("start", gone())
      await expect(prompt(test, "Summarize")).rejects.toMatchObject({
        code: -32002,
      })
    },
  },
  {
    command: "stop",
    live: true,
    async fail(test) {
      test.sources[0]?.stop.mockRejectedValueOnce(gone())
      await test.agent.notify(methods.agent.session.cancel, {
        sessionId: SESSION,
      })
    },
  },
  {
    command: "steer",
    live: true,
    async fail(test) {
      test.sources[0]?.steer.mockRejectedValueOnce(gone())
      await expect(
        test.agent.request(AOS_METHODS.session.steer, {
          sessionId: SESSION,
          requestId: "steer-1",
          text: "Also check the tests",
        })
      ).rejects.toMatchObject({ code: -32002 })
    },
  },
  {
    command: "answer",
    live: true,
    async fail(test) {
      // Each member allows the request; the first answer continues the turn.
      test.faults.failOnce("start", gone())
      test.sources[0]?.emit({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [
          {
            requestId: "approval-1",
            kind: PendingRequestKind.Permission,
            message: "permission-required",
          },
        ],
      })
      test.sources[0]?.finish()
    },
  },
  {
    command: "set-config",
    async fail(test) {
      test.faults.failOnce("updateModel", gone())
      await expect(
        test.agent.request(methods.agent.session.setConfigOption, {
          sessionId: SESSION,
          configId: "model",
          type: "id",
          value: "opus",
        })
      ).rejects.toMatchObject({ code: -32002 })
    },
  },
  ...(
    [
      ["rename", { title: "Renamed" }],
      ["archive", { archived: true }],
      ["pin", { pinned: true }],
    ] as const
  ).map(([command, patch]) => ({
    command,
    async fail(test: Test) {
      test.faults.failOnce("updateSession", gone())
      await expect(
        test.agent.request(AOS_METHODS.session.update, {
          sessionId: SESSION,
          ...patch,
        })
      ).rejects.toMatchObject({ code: -32002 })
    },
  })),
  {
    command: "delete",
    async fail(test) {
      test.faults.failOnce("deleteSession", gone())
      await expect(
        test.agent.request(methods.agent.session.delete, {
          sessionId: SESSION,
        })
      ).rejects.toMatchObject({ code: -32002 })
    },
  },
]

describe("gone Session commands", () => {
  it.each(COMMANDS)(
    "ends a Session its $command finds gone for every member once, and reads it no more",
    async ({ live, fail }) => {
      const test = await harness({ providerIds: true })
      const other = await test.connect("connection-2")
      await test.list()
      await other.list()
      await open(test)
      await open(other)
      const members = [test, other] as const
      if (live) await running(test, members)
      const clock = useFakeClock()

      await fail(test)
      for (const { recorder } of members)
        await recorder.wait(notice, "the not_found notice")
      const ended = reads(test)
      for (const source of test.sources) source.finish()
      await clock.advance(60_000)

      for (const { recorder } of members)
        expect(recorder.of(AOS_METHODS.notify.error)).toEqual([
          {
            method: AOS_METHODS.notify.error,
            params: {
              sessionId: SESSION,
              code: "not_found",
              message: "not_found",
            },
          },
        ])
      expect(reads(test)).toBe(ended)
      expect(
        test.logs.records().filter(({ message }) => message === "session.gone")
      ).toHaveLength(1)
      expect(test.coordinator.gauges().executions).toBe(0)
      test.close()
      other.close()
      await clock.advance(60_000)
      assertLeakFree(test)
    }
  )
})
