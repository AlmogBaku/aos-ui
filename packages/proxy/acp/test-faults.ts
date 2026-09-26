/**
 * A fault-injecting wrapper over a `ServerRuntime`, for the tests that prove
 * each operation recovers from a single fault. Unarmed, it forwards every call
 * unchanged; each armed fault stands for one way a real provider fails.
 */
import type { TurnEvent } from "../core/events"
import {
  ServerSessionNotFoundError,
  type ServerRuntime,
  type ServerTurnEngine,
  type ServerTurnHandle,
  type ServerTurnListener,
  type SessionScope,
} from "../core/runtime"

type Operations<T, Answer> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => Answer
    ? K
    : never
}[keyof T]

/** The turn operations, which answer with a handle to a turn's events. */
export type TurnOperation = Operations<ServerTurnEngine, Promise<unknown>>

/** Every operation that answers asynchronously, so a fault can hold or fail it. */
export type FaultOperation =
  Operations<ServerRuntime, Promise<unknown>> | TurnOperation

type SyncOperation = Exclude<
  Operations<ServerRuntime, unknown> | Operations<ServerTurnEngine, unknown>,
  FaultOperation
>

/** Answers at once, so no fault reaches it but `gone`, through its listener. */
const SYNC_OPERATIONS: Record<SyncOperation, true> = {
  resolveProviderSessionId: true,
  publicError: true,
  subscribeTurns: true,
}

type GoneSession = Pick<SessionScope, "sessionId" | "providerSessionId">

/** Whether one argument names the Session, by either id or as its scope. */
function names(arg: unknown, session: GoneSession) {
  if (typeof arg === "string")
    return arg === session.sessionId || arg === session.providerSessionId
  if (typeof arg !== "object" || arg === null) return false
  const scope = arg as Partial<GoneSession>
  return (
    scope.sessionId === session.sessionId ||
    scope.providerSessionId === session.providerSessionId
  )
}

/** Settles only as the call's own signal aborts, and never without one. */
function hang(args: unknown[]) {
  const signal = args.find(
    (arg): arg is AbortSignal => arg instanceof AbortSignal
  )
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    })
    if (signal?.aborted) reject(signal.reason)
  })
}

function isHandle(value: unknown): value is ServerTurnHandle {
  return typeof value === "object" && value !== null && "events" in value
}

/** The handle, reading as `events` whatever the given iterable yields. */
function withEvents(
  handle: ServerTurnHandle,
  events: AsyncIterable<TurnEvent>
): ServerTurnHandle {
  return new Proxy(handle, {
    get(inner, key) {
      if (key === "events") return events
      const value: unknown = Reflect.get(inner, key)
      return typeof value === "function" ? value.bind(inner) : value
    },
  })
}

async function* replayed(
  first: IteratorResult<TurnEvent>,
  rest: AsyncIterator<TurnEvent>
) {
  if (first.done) return
  yield first.value
  yield* { [Symbol.asyncIterator]: () => rest }
}

/**
 * Holds a turn operation's answer until its turn has emitted its first event,
 * or ended, then answers with a handle that replays that event first.
 */
async function afterFirstEvent(answer: unknown) {
  const result: unknown = await answer
  const nested: unknown =
    typeof result === "object" && result !== null && "handle" in result
      ? result.handle
      : undefined
  const handle = isHandle(result) ? result : isHandle(nested) ? nested : null
  if (!handle) return result
  const iterator = handle.events[Symbol.asyncIterator]()
  const late = withEvents(handle, replayed(await iterator.next(), iterator))
  return result === handle ? late : { ...(result as object), handle: late }
}

export function withFaults(runtime: ServerRuntime) {
  const failures = new Map<FaultOperation, unknown>()
  const hangs = new Set<FaultOperation>()
  const late = new Set<TurnOperation>()
  const gone: GoneSession[] = []
  const isGone = (args: unknown[]) =>
    gone.some((session) => args.some((arg) => names(arg, session)))

  function call(operation: string, args: unknown[], answer: () => unknown) {
    if (Object.hasOwn(SYNC_OPERATIONS, operation)) {
      if (operation !== "subscribeTurns" || !isGone(args)) return answer()
      const listener = args[1] as ServerTurnListener
      queueMicrotask(() => listener.onError(new ServerSessionNotFoundError()))
      return () => undefined
    }
    const faulted = operation as FaultOperation
    if (isGone(args)) return Promise.reject(new ServerSessionNotFoundError())
    if (failures.has(faulted)) {
      const error = failures.get(faulted)
      failures.delete(faulted)
      return Promise.reject(error)
    }
    if (hangs.delete(faulted)) return hang(args)
    if (late.delete(faulted as TurnOperation)) return afterFirstEvent(answer())
    return answer()
  }

  /** `target` with each operation faulted, and `replaced` read over it. */
  function faulty<T extends object>(target: T, replaced: Partial<T> = {}): T {
    return new Proxy(target, {
      get(inner, key) {
        if (Object.hasOwn(replaced, key)) return Reflect.get(replaced, key)
        const value: unknown = Reflect.get(inner, key)
        if (typeof key !== "string" || typeof value !== "function") return value
        return (...args: unknown[]) =>
          call(key, args, () => value.apply(inner, args))
      },
    })
  }

  return {
    /** The runtime every fault reaches through; hand it to whatever is tested. */
    runtime: faulty(runtime, { turns: faulty(runtime.turns) }),
    /** The next call of `operation` rejects with `error` and reaches nothing. */
    failOnce(
      operation: FaultOperation,
      error: unknown = new Error(`${operation} failed`)
    ) {
      failures.set(operation, error)
    },
    /** The next call of `operation` settles only as its signal aborts. */
    hangUntilAborted(operation: FaultOperation) {
      hangs.add(operation)
    },
    /** Every later call for the Session rejects as not found. */
    gone(session: GoneSession) {
      gone.push(session)
    },
    /** The next call of `operation` answers only after its turn's first event. */
    answerAfterEvents(operation: TurnOperation) {
      late.add(operation)
    },
  }
}
