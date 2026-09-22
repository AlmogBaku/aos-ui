/**
 * The typed native run boundary of the Hermes adapter.
 *
 * Every native mutation answers with one of three authoritative classes and
 * never with a collapsed "something failed": Hermes accepted the write, Hermes
 * rejected it with a code this module maps to a public reason, or the
 * acknowledgement was lost. A lost acknowledgement is never retried here.
 *
 * Read-only pre-checks (the command catalog, the rewind history read) are not
 * part of that vocabulary: when one fails Hermes never saw the user's text, so
 * the failure is an outage and the caller must not present it as a refusal.
 */
import type { RequestReply, RunInterruptOutcome } from "../../core/events"

import {
  HermesRpcRejectedError,
  HermesRpcUncertainError,
  HermesUnavailableError,
  throwUnavailable,
  type HermesLog,
  type HermesRpcTransport,
} from "./gateway"
import type { AttachmentObserver } from "./attachment-registry"
import { isRecord, trimmedText } from "./native"
import { projectHermesHistory } from "./history"
import {
  executeSlashCommand,
  nativeSlashInvocation,
  type HermesSlashExecution,
} from "./slash-commands"
import { HermesRunRewindConflictError } from "./run-failures"
import type { HermesRecovery } from "./run-frames"
import type { HermesRunScope } from "./run-state"
import { ServerRunSteerUncertainError } from "../../core/runtime"

/** Hermes' own five native turn states; `absent` means Hermes does not list it. */
export type HermesNativeStatus =
  "starting" | "working" | "waiting" | "idle" | "absent"

export type HermesSubmitPrompt = {
  scope: HermesRunScope
  text: string
  runId: string
  rewindSourceId?: string
  /**
   * Re-send exactly the write Hermes refused, as that refusal reported it. Only
   * the single "that live Session is gone" retry sets it, and it repeats the
   * `prompt.submit` alone: a native command is never executed twice.
   */
  refused?: HermesRefusedPrompt
}

/**
 * The `prompt.submit` params Hermes refused. The run keeps it opaque: it
 * carries the already expanded prompt text, which is the only part of a
 * rejected write that may be repeated.
 */
export type HermesRefusedPrompt = {
  readonly params: Readonly<Record<string, unknown>>
}

export type HermesSubmitCompletion = {
  output: string
  composerPrefill?: string
}

/** Native admission status of an accepted prompt (`PromptSubmitStatus`). */
export type HermesSubmitStatus =
  "streaming" | "queued" | "steered" | "redirected"

export type HermesSubmitRejection =
  | "command-with-attachments"
  | "session-gone"
  | "busy"
  | "storage"
  | "invalid"
  | "unknown"

/**
 * What Hermes said about a dispatched prompt. `accepted` carries its own native
 * admission status; `rejected` is an authoritative refusal with a public reason;
 * `uncertain` means the prompt was written without a known result, either
 * because the acknowledgement was lost in transport or because the reply carried
 * no admission status AOS understands. An uncertain write is never re-sent.
 */
export type HermesSubmitOutcome =
  | {
      acknowledgement: "accepted"
      status: HermesSubmitStatus
      completion?: HermesSubmitCompletion
    }
  | {
      acknowledgement: "rejected"
      reason: HermesSubmitRejection
      /** Set when a `prompt.submit` was refused, so nothing it carried ran. */
      refused?: HermesRefusedPrompt
    }
  | { acknowledgement: "uncertain" }

export type HermesInteractionSnapshot = {
  running: boolean
  status: "waiting-for-input" | "running" | "idle" | "unknown"
  outcome?: RunInterruptOutcome
}

export interface HermesRunNative {
  resume(
    scope: HermesRunScope
  ): Promise<{ liveSessionId: string; running: boolean }>
  observe(
    liveSessionId: string,
    observer: AttachmentObserver
  ): Promise<() => void>
  cursor(liveSessionId: string): Promise<{ epoch: string; latestSeq: number }>
  replay(liveSessionId: string, after: number): Promise<HermesRecovery>
  submit(
    liveSessionId: string,
    prompt: HermesSubmitPrompt
  ): Promise<HermesSubmitOutcome>
  interrupt(liveSessionId: string): Promise<"interrupted" | "gone">
  redirect(
    liveSessionId: string,
    text: string
  ): Promise<"redirected" | "queued">
  status(liveSessionId: string): Promise<HermesNativeStatus>
  retain(scope: HermesRunScope, reason: string): Promise<() => void>
  inspectExecution(
    scope: HermesRunScope & { runId: string }
  ): Promise<HermesInteractionSnapshot>
  onInterrupt(
    scope: HermesRunScope,
    listener: (outcome: RunInterruptOutcome) => void
  ): () => void
  respondInteractions(
    scope: HermesRunScope & { runId: string },
    resume: readonly RequestReply[]
  ): Promise<readonly { status: string }[]>
}

/** The durable-to-live binding surface `run-native.ts` depends on. */
export type HermesNativeAttachments = {
  ensure(
    scope: HermesRunScope
  ): Promise<{ liveSessionId: string; running: boolean }>
  retain(scope: HermesRunScope, reason: string): Promise<() => void>
  subscribeLive(
    liveSessionId: string,
    observer: AttachmentObserver
  ): Promise<() => void>
  invalidate(liveSessionId: string): void
}

/** The interaction surface `run-native.ts` depends on (`HermesInteractions`). */
export type HermesNativeInteractions = {
  onInterrupt(
    scope: HermesRunScope,
    listener: (outcome: RunInterruptOutcome) => void
  ): () => void
  respond(
    scope: HermesRunScope & { runId: string },
    entry: RequestReply
  ): Promise<{ status: string }>
  resume(
    scope: HermesRunScope & { runId: string }
  ): Promise<HermesInteractionSnapshot>
}

export type HermesNativeOptions = {
  transport: HermesRpcTransport
  attachments: HermesNativeAttachments
  interactions: HermesNativeInteractions
  /** Authoritative durable history, used only for rewind addressing. */
  history(scope: HermesRunScope): Promise<readonly unknown[]>
  log?: HermesLog
}

/** A replayed ring page may legitimately be large; a single reply is bounded. */
const MAX_REPLAY_RESPONSE_BYTES = 6 * 1_048_576

/**
 * Hermes' documented rejection codes for a session-scoped mutation. Anything
 * else is `unknown`: authoritative, but without a public reason of its own.
 */
const REJECTION_BY_CODE = new Map<number, HermesSubmitRejection>([
  [4001, "session-gone"],
  [4007, "session-gone"],
  [4009, "busy"],
  [4090, "busy"],
  [4091, "busy"],
  [5070, "storage"],
  [5071, "storage"],
  [-32600, "invalid"],
  [-32602, "invalid"],
])

/** Hermes has no live Session left to address; the binding must be rebound. */
const GONE_CODES = new Set([4001, 4007, -32602])

/**
 * Classify the reply to a write Hermes already accepted. An unusable admission
 * status says nothing about the turn: Hermes may well be running it, so the
 * acknowledgement is lost rather than an outage the caller may report as one.
 */
function submittedOutcome(result: unknown): HermesSubmitOutcome {
  const status = isRecord(result) ? result.status : undefined
  if (
    status === "streaming" ||
    status === "queued" ||
    status === "steered" ||
    status === "redirected"
  )
    return { acknowledgement: "accepted", status }
  return { acknowledgement: "uncertain" }
}

function completionOutcome(
  execution: Extract<HermesSlashExecution, { kind: "completion" }>
): HermesSubmitOutcome {
  return {
    acknowledgement: "accepted",
    // A synchronous command answered in band, so no native turn was queued
    // behind another; the caller finishes the run from `completion`.
    status: "streaming",
    completion: {
      output: execution.output,
      ...(execution.composerPrefill === undefined
        ? {}
        : { composerPrefill: execution.composerPrefill }),
    },
  }
}

/**
 * Address the authoritative durable user row a rewind must truncate before.
 * A missing or moved row is a conflict, never a silent append.
 */
function rewindSubmitParams(
  rows: readonly unknown[],
  rewindSourceId: string
): Record<string, unknown> {
  const history = projectHermesHistory(rows)
  const targetIndex = history.findIndex(
    ({ id, role }) => id === rewindSourceId && role === "user"
  )
  const target = targetIndex < 0 ? undefined : history[targetIndex]
  if (!target) throw new HermesRunRewindConflictError()

  const row = /^hermes-row-(\d+)$/u.exec(target.id)?.[1]
  const rowId = row === undefined ? undefined : Number(row)
  const address =
    rowId !== undefined && Number.isSafeInteger(rowId) && rowId > 0
      ? { truncate_before_row_id: rowId }
      : !target.id.startsWith("hermes-history-")
        ? { truncate_before_message_id: target.id }
        : undefined
  if (!address) throw new HermesRunRewindConflictError()

  return {
    confirm_truncate: true,
    ...address,
    ...(history.slice(0, targetIndex).some(({ role }) => role === "user")
      ? {}
      : { confirm_empty_truncate: true }),
  }
}

export class HermesNativeRuntime implements HermesRunNative {
  readonly #transport: HermesRpcTransport
  readonly #attachments: HermesNativeAttachments
  readonly #interactions: HermesNativeInteractions
  readonly #history: (scope: HermesRunScope) => Promise<readonly unknown[]>
  readonly #log: HermesLog | undefined

  constructor(options: HermesNativeOptions) {
    this.#transport = options.transport
    this.#attachments = options.attachments
    this.#interactions = options.interactions
    this.#history = options.history
    this.#log = options.log
  }

  resume(scope: HermesRunScope) {
    return this.#attachments.ensure(scope)
  }

  async observe(liveSessionId: string, observer: AttachmentObserver) {
    try {
      // The registry owns the single native subscription and routes frames by
      // live Session; a caller that never attached has nothing to observe.
      return await this.#attachments.subscribeLive(liveSessionId, observer)
    } catch (error) {
      throwUnavailable(error)
    }
  }

  async cursor(liveSessionId: string) {
    // The maximum watermark asks Hermes only where its ring is now: no retained
    // event is returned, so this reply needs no enlarged bound.
    const recovery = await this.#since(liveSessionId, Number.MAX_SAFE_INTEGER)
    return { epoch: recovery.epoch, latestSeq: recovery.lastSeen }
  }

  async replay(liveSessionId: string, after: number): Promise<HermesRecovery> {
    // Hermes answers `session.events.since` with -32602 unless the cursor is an
    // integer; an unusable cursor is a caller fault, never a native read.
    if (!Number.isSafeInteger(after) || after < 0)
      throw new HermesUnavailableError()
    return this.#since(liveSessionId, after, MAX_REPLAY_RESPONSE_BYTES)
  }

  async submit(
    liveSessionId: string,
    prompt: HermesSubmitPrompt
  ): Promise<HermesSubmitOutcome> {
    // A re-send repeats the refused write and nothing else: the command that
    // produced this text, if any, already ran, and its params — including a
    // rewind the history read validated moments earlier — are re-sent unchanged
    // rather than derived again against the rebound Session.
    if (prompt.refused)
      return this.#submitPrompt(liveSessionId, prompt.refused.params)
    let invocation: Awaited<ReturnType<typeof nativeSlashInvocation>>
    if (prompt.text.startsWith("/")) {
      try {
        invocation = await nativeSlashInvocation(
          this.#transport,
          { session_id: liveSessionId },
          prompt.text
        )
      } catch (error) {
        // A read-only catalog lookup: Hermes never saw the user's text.
        throwUnavailable(error)
      }
      if (invocation && prompt.scope.hasAttachments)
        return {
          acknowledgement: "rejected",
          reason: "command-with-attachments",
        }
    }

    let rewind: Record<string, unknown> = {}
    if (!invocation && prompt.rewindSourceId !== undefined) {
      try {
        rewind = rewindSubmitParams(
          await this.#history(prompt.scope),
          prompt.rewindSourceId
        )
      } catch (error) {
        if (error instanceof HermesRunRewindConflictError) throw error
        throwUnavailable(error)
      }
      // A rewind is the one submit that destroys durable rows, so the address it
      // truncates before is reported exactly as Hermes receives it. The prompt
      // replacing those rows is never logged.
      this.#log?.warn("hermes.rewind.submit", {
        sessionId: prompt.scope.sessionId,
        rewindSourceId: prompt.rewindSourceId,
        ...rewind,
      })
    }

    if (invocation) {
      let execution: HermesSlashExecution
      try {
        execution = await executeSlashCommand(
          this.#transport,
          liveSessionId,
          invocation.name,
          invocation.args
        )
      } catch (error) {
        // One label for the command itself: `slash.exec` and its
        // `command.dispatch` fallback. Its expansion is an ordinary submit.
        return this.#writeOutcome("slash.command", liveSessionId, error)
      }
      return execution.kind === "expanded"
        ? this.#submitPrompt(liveSessionId, { text: execution.text })
        : completionOutcome(execution)
    }

    return this.#submitPrompt(liveSessionId, { text: prompt.text, ...rewind })
  }

  /**
   * The one `prompt.submit` write. A refusal reports the params it carried, so
   * the single session-gone re-send repeats that write against the rebound
   * live Session instead of running the command path a second time.
   */
  async #submitPrompt(
    liveSessionId: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<HermesSubmitOutcome> {
    let result: unknown
    try {
      result = await this.#transport.request("prompt.submit", {
        session_id: liveSessionId,
        ...params,
      })
    } catch (error) {
      const outcome = this.#writeOutcome("prompt.submit", liveSessionId, error)
      return outcome.acknowledgement === "rejected"
        ? { ...outcome, refused: { params } }
        : outcome
    }
    return submittedOutcome(result)
  }

  async interrupt(liveSessionId: string): Promise<"interrupted" | "gone"> {
    try {
      await this.#transport.request("session.interrupt", {
        session_id: liveSessionId,
      })
    } catch (error) {
      if (error instanceof HermesRpcRejectedError) {
        this.#logRejection("session.interrupt", error)
        // Hermes stating there is no live Session left is an authoritative
        // answer that nothing remains to stop, not an uncertain mutation.
        if (error.code !== undefined && GONE_CODES.has(error.code)) {
          this.#attachments.invalidate(liveSessionId)
          return "gone"
        }
        throw new HermesUnavailableError()
      }
      if (error instanceof HermesRpcUncertainError) throw error
      throwUnavailable(error)
    }
    return "interrupted"
  }

  async redirect(liveSessionId: string, text: string) {
    let payload: unknown
    try {
      payload = await this.#transport.request("session.redirect", {
        session_id: liveSessionId,
        text,
      })
    } catch (error) {
      if (error instanceof HermesRpcUncertainError)
        throw new ServerRunSteerUncertainError()
      if (error instanceof HermesRpcRejectedError) {
        this.#logRejection("session.redirect", error)
        if (error.code !== undefined && GONE_CODES.has(error.code))
          this.#attachments.invalidate(liveSessionId)
        throw new HermesUnavailableError()
      }
      throwUnavailable(error)
    }
    if (
      !isRecord(payload) ||
      (payload.status !== "redirected" && payload.status !== "queued") ||
      typeof payload.text !== "string"
    )
      throw new HermesUnavailableError()
    return payload.status
  }

  async status(liveSessionId: string): Promise<HermesNativeStatus> {
    let payload: unknown
    try {
      payload = await this.#transport.request("session.active_list", {})
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(payload) || !Array.isArray(payload.sessions))
      throw new HermesUnavailableError()
    const session = payload.sessions.find(
      (value) => isRecord(value) && trimmedText(value.id) === liveSessionId
    )
    // Hermes lists every live Session it owns. An absent row is its own state:
    // it is never evidence that the Session is idle and submit-ready.
    if (!isRecord(session)) return "absent"
    const status = session.status
    if (
      status === "starting" ||
      status === "working" ||
      status === "waiting" ||
      status === "idle"
    )
      return status
    throw new HermesUnavailableError()
  }

  retain(scope: HermesRunScope, reason: string) {
    return this.#attachments.retain(scope, reason)
  }

  inspectExecution(scope: HermesRunScope & { runId: string }) {
    return this.#interactions.resume(scope)
  }

  /**
   * Interactions own the native request stream and the retainer that keeps a
   * Session with a pending request addressable, so a run only asks to be told
   * when one interrupts its Session.
   */
  onInterrupt(
    scope: HermesRunScope,
    listener: (outcome: RunInterruptOutcome) => void
  ) {
    return this.#interactions.onInterrupt(scope, listener)
  }

  async respondInteractions(
    scope: HermesRunScope & { runId: string },
    resume: readonly RequestReply[]
  ) {
    await this.#interactions.resume(scope)
    return Promise.all(
      resume.map((entry) => this.#interactions.respond(scope, entry))
    )
  }

  /**
   * Classify a failure of a dispatched write. A JSON-RPC error frame is an
   * authoritative rejection with a public reason; a lost acknowledgement is
   * uncertain, exactly like a reply whose admission status is unusable
   * (`submittedOutcome`); anything else means nothing usable came back.
   */
  #writeOutcome(
    method: string,
    liveSessionId: string,
    error: unknown
  ): HermesSubmitOutcome {
    if (error instanceof HermesRpcRejectedError) {
      this.#logRejection(method, error)
      const reason =
        (error.code === undefined
          ? undefined
          : REJECTION_BY_CODE.get(error.code)) ?? "unknown"
      if (reason === "session-gone") this.#attachments.invalidate(liveSessionId)
      return { acknowledgement: "rejected", reason }
    }
    if (error instanceof HermesRpcUncertainError)
      return { acknowledgement: "uncertain" }
    throwUnavailable(error)
  }

  /** The native code is the diagnosable part; no native message is retained. */
  #logRejection(method: string, error: HermesRpcRejectedError) {
    this.#log?.warn("hermes.native.rejected", {
      method,
      ...(error.code === undefined ? {} : { code: error.code }),
    })
  }

  async #since(
    liveSessionId: string,
    lastSeen: number,
    maxResponseBytes?: number
  ): Promise<HermesRecovery> {
    let payload: unknown
    try {
      payload = await this.#transport.request(
        "session.events.since",
        { session_id: liveSessionId, last_seen: lastSeen },
        maxResponseBytes === undefined ? undefined : { maxResponseBytes }
      )
    } catch (error) {
      throwUnavailable(error)
    }
    if (!isRecord(payload) || !Array.isArray(payload.events))
      throw new HermesUnavailableError()
    const epoch = trimmedText(payload.epoch)
    const latestSeq = payload.latest_seq ?? payload.last_seen
    if (
      !epoch ||
      typeof latestSeq !== "number" ||
      !Number.isSafeInteger(latestSeq) ||
      latestSeq < 0 ||
      (payload.truncated !== undefined &&
        typeof payload.truncated !== "boolean")
    )
      throw new HermesUnavailableError()
    return {
      epoch,
      lastSeen: latestSeq,
      truncated: payload.truncated === true,
      events: payload.events,
    }
  }
}
