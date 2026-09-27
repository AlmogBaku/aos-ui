/**
 * The failure contract every server runtime meets (ADR D3), proven once over
 * each adapter's own native fake (ADR D14). An adapter's `contract.test.ts`
 * calls `runServerRuntimeContract` with a harness that builds its runtime and
 * drives that fake. A row the native server has no concept for is named in
 * `gaps` with its reason, and every run lists it as skipped with that reason.
 *
 * Test-only: the architecture guard keeps production code from importing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../../test/support/fake-clock"
import {
  isUncertainFailure,
  TurnEventKind,
  type PromptTurnInput,
  type TurnEvent,
} from "./events"
import { coreFailure, type CallerError, type PublicFailure } from "./failures"
import type { ServerRuntime, ServerTurnHandle, SessionScope } from "./runtime"

/** The contract's rows, each named for the rule it protects. */
export type RuntimeContractRow =
  | "deletedSessionIsGone"
  | "rejectionsKeepTheirNativeCause"
  | "recoveryPositionRoundTrips"
  | "typedMessageFields"
  | "callerErrorsAreNotRetried"
  | "linkLossFailsReadsAndTurns"
  | "settledTurnsFreeRecords"
  | "closeLeavesNoTimer"

/** What one adapter's fake lets the contract do to its runtime. */
export type RuntimeContractHarness = {
  readonly runtime: ServerRuntime
  /** An idle Session the fake holds. */
  readonly scope: SessionScope
  /** Stream one reply fragment into the running turn. */
  progress(): Promise<void>
  /** End the running turn natively. */
  finish(): Promise<void>
  /** Delete the Session natively. */
  deleteSession(): void
  /**
   * Answer every native call from now on with a native error, and recognize
   * that error wherever it travels.
   */
  failNative(): (error: unknown) => boolean
  /** Refuse every native call from now on as the caller error `kind`. */
  refuseAsCaller(kind: CallerError): void
  /** Native calls and dials the fake has answered or refused so far. */
  nativeCalls(): number
  /** Take the native link down and keep it down. */
  dropLink(): Promise<void>
  /** Let the native link come back. */
  restoreLink(): Promise<void>
  /** Seed a correction and a failed turn natively; only `typedMessageFields` asks. */
  seedTypedMessages?(): void
  /** The per-Session records the runtime holds; only `settledTurnsFreeRecords` asks. */
  records?(): number
  /** Release the runtime as its factory's `close` does. */
  close(): Promise<void>
}

export type RuntimeContractOptions = {
  /** The caller errors this runtime can report for a refused read. */
  callerErrors: readonly CallerError[]
  /** Rows skipped, each with the concept its native server lacks. */
  gaps?: Partial<Record<RuntimeContractRow, string>>
}

type Clock = ReturnType<typeof useFakeClock>

/** Longer than any runtime's grace for a lost link or a stalled call. */
const OUTAGE_MS = 60_000
const STEP_MS = 100
const FAILURE_KINDS = ["gone", "unavailable", "uncertain"] as const
const RESOLVED = Symbol("resolved")

/** What the proxy reads a rejection as, whichever layer raised it. */
function classify(runtime: ServerRuntime, error: unknown) {
  return coreFailure(error) ?? runtime.publicError(error)
}

/** The rejection `call` ends in, or `RESOLVED` when it resolves. */
async function rejectionOf(call: Promise<unknown>) {
  try {
    await call
  } catch (error) {
    return error
  }
  return RESOLVED
}

/** `error` and every cause it wraps. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  for (
    let cause = error;
    cause !== undefined && !chain.includes(cause);
    cause = cause instanceof Error ? cause.cause : undefined
  )
    chain.push(cause)
  return chain
}

/** Advance the clock until `promise` settles, as a runtime waiting on it would. */
async function until<T>(clock: Clock, promise: Promise<T>): Promise<T> {
  let settled = false
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  await clock.advance(0)
  for (let waited = 0; !settled; waited += STEP_MS) {
    if (waited >= OUTAGE_MS) throw new Error("The runtime never settled")
    await clock.advance(STEP_MS)
  }
  return promise
}

/**
 * A global transport that throws, so a harness that lost its fake's transport
 * fails its rows instead of reaching a real server on a default address.
 */
function unreachable(name: string) {
  return function unreachableTransport() {
    throw new Error(`The runtime contract reached the global ${name}`)
  }
}

/** Every event the handle streams, gathered as it arrives. */
function collect(handle: ServerTurnHandle) {
  const events: TurnEvent[] = []
  const done = (async () => {
    for await (const event of handle.events) events.push(event)
  })()
  return { events, done }
}

let promptCount = 0
function prompt(): PromptTurnInput {
  promptCount += 1
  return {
    turnId: `contract-turn-${promptCount}`,
    messageId: `contract-user-${promptCount}`,
    prompt: `Contract prompt ${promptCount}`,
  }
}

/** Runs one turn from its start to its native end. */
async function settledTurn(harness: RuntimeContractHarness, clock: Clock) {
  const handle = await until(
    clock,
    harness.runtime.turns.start(harness.scope, prompt())
  )
  const stream = collect(handle)
  await harness.progress()
  await harness.finish()
  await until(clock, stream.done)
  await until(clock, handle.settled)
  return stream.events
}

export function runServerRuntimeContract(
  name: string,
  createHarness: () => RuntimeContractHarness | Promise<RuntimeContractHarness>,
  { callerErrors, gaps = {} }: RuntimeContractOptions
) {
  function row(
    id: RuntimeContractRow,
    title: string,
    body: (
      harness: RuntimeContractHarness,
      clock: Clock,
      close: () => Promise<void>
    ) => Promise<void>
  ) {
    if (gaps[id] !== undefined) {
      it.skip(`${title} (gap: ${gaps[id]})`)
      return
    }
    it(title, async () => {
      const clock = useFakeClock()
      const harness = await until(clock, Promise.resolve(createHarness()))
      let closing: Promise<void> | undefined
      const close = () => (closing ??= harness.close())
      try {
        await body(harness, clock, close)
      } finally {
        await close()
      }
    })
  }

  describe(`${name} server runtime contract`, () => {
    beforeEach(() => {
      // A vendored client reads the ready states off the global class.
      const { CONNECTING, OPEN, CLOSING, CLOSED } = WebSocket
      vi.stubGlobal("fetch", unreachable("fetch"))
      vi.stubGlobal(
        "WebSocket",
        Object.assign(unreachable("WebSocket"), {
          CONNECTING,
          OPEN,
          CLOSING,
          CLOSED,
        })
      )
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    row(
      "deletedSessionIsGone",
      "fails a turn on a natively deleted Session as gone",
      async (harness, clock) => {
        const { agentId, providerSessionId } = harness.scope
        // The Session reads before it is deleted, so gone means deleted.
        await expect(
          until(clock, harness.runtime.getSession(agentId, providerSessionId))
        ).resolves.toMatchObject({ agentId })
        harness.deleteSession()

        const error = await until(
          clock,
          rejectionOf(harness.runtime.turns.start(harness.scope, prompt()))
        )

        expect(classify(harness.runtime, error)?.kind).toBe("gone")
      }
    )

    row(
      "rejectionsKeepTheirNativeCause",
      "classifies every rejected call by kind and keeps the native error as its cause",
      async (harness, clock) => {
        const { runtime, scope } = harness
        const isNative = harness.failNative()
        const calls = {
          listAgents: () => runtime.listAgents(),
          listSessions: () => runtime.listSessions(scope.agentId, 20, 0),
          getSession: () =>
            runtime.getSession(scope.agentId, scope.providerSessionId),
          history: () =>
            runtime.history(scope.agentId, scope.providerSessionId, 20, 0),
          start: () => runtime.turns.start(scope, prompt()),
        }

        for (const [call, run] of Object.entries(calls)) {
          const error = await until(clock, rejectionOf(run()))
          const failure: PublicFailure | undefined =
            error === RESOLVED ? undefined : classify(runtime, error)
          expect.soft({ call, kind: failure?.kind }).toEqual({
            call,
            kind: expect.toBeOneOf([...FAILURE_KINDS, ...callerErrors]),
          })
          expect
            .soft({
              call,
              native: causeChain(failure?.cause).some(isNative),
            })
            .toEqual({ call, native: true })
        }
      }
    )

    row(
      "recoveryPositionRoundTrips",
      "recovers an interrupted turn from the very position its handle minted",
      async (harness, clock) => {
        const input = prompt()
        const handle = await until(
          clock,
          harness.runtime.turns.start(harness.scope, input)
        )
        collect(handle)
        await harness.progress()
        await harness.dropLink()
        await clock.advance(OUTAGE_MS)
        await harness.restoreLink()
        await clock.advance(OUTAGE_MS)

        const position = handle.recoveryPosition()
        expect(position).toEqual(expect.any(String))
        const recovered = await until(
          clock,
          harness.runtime.turns.recover(harness.scope, {
            sessionId: harness.scope.sessionId,
            turnId: input.turnId,
            position: position!,
          })
        )
        const stream = collect(recovered)
        await harness.finish()
        await until(clock, stream.done)

        expect(stream.events.at(-1)?.kind).toBe(TurnEventKind.TurnEnded)
      }
    )

    row(
      "typedMessageFields",
      "marks a correction and a failed turn's code as typed message fields",
      async (harness, clock) => {
        harness.seedTypedMessages!()

        const page = await until(
          clock,
          harness.runtime.history(
            harness.scope.agentId,
            harness.scope.providerSessionId,
            50,
            0
          )
        )

        expect(page.messages).toContainEqual(
          expect.objectContaining({ correction: true })
        )
        expect(page.messages).toContainEqual(
          expect.objectContaining({ turnErrorCode: expect.any(String) })
        )
      }
    )

    for (const kind of callerErrors)
      row(
        "callerErrorsAreNotRetried",
        `reports a refusal as ${kind} and never retries it`,
        async (harness, clock) => {
          harness.refuseAsCaller(kind)

          const error = await until(
            clock,
            rejectionOf(harness.runtime.listAgents())
          )
          const calls = harness.nativeCalls()
          await clock.advance(OUTAGE_MS)

          expect(classify(harness.runtime, error)?.kind).toBe(kind)
          expect(harness.nativeCalls()).toBe(calls)
        }
      )

    row(
      "linkLossFailsReadsAndTurns",
      "fails a read unavailable and leaves an in-flight turn uncertain once the link is lost",
      async (harness, clock) => {
        const handle = await until(
          clock,
          harness.runtime.turns.start(harness.scope, prompt())
        )
        const stream = collect(handle)
        await harness.progress()

        await harness.dropLink()
        const read = rejectionOf(harness.runtime.listAgents())
        await clock.advance(OUTAGE_MS)

        expect(classify(harness.runtime, await until(clock, read))?.kind).toBe(
          "unavailable"
        )
        expect(stream.events.some(isUncertainFailure)).toBe(true)
      }
    )

    row(
      "settledTurnsFreeRecords",
      "keeps no per-Session record once its turns settled",
      async (harness, clock) => {
        for (let turn = 0; turn < 3; turn += 1)
          await settledTurn(harness, clock)

        expect(harness.records!()).toBe(0)
      }
    )

    row(
      "closeLeavesNoTimer",
      "leaves no timer behind once closed",
      async (harness, clock, close) => {
        await settledTurn(harness, clock)

        await close()

        expect(vi.getTimerCount()).toBe(0)
      }
    )
  })
}
