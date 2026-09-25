import {
  methods,
  SessionUpdate,
  StateUpdate,
  type AgentContext,
} from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionContextResponse } from "../../protocol"
import {
  AOS_METHODS,
  AOS_META_KEY,
  AOS_STOP_REASONS,
  AosStateMetaSchema,
} from "../../protocol/acp"
import type { Seat } from "../core/channel"
import { PendingRequestKind, type PendingRequest } from "../core/events"
import {
  unhandledKind,
  type MemberCommands,
  type MemberConnection,
  type MemberEvent,
  type TurnStream,
} from "../core/member"
import type { SessionExecutionState } from "../core/session-coordinator"
import { redactForLog } from "../redaction"
import { commandsUpdate, sessionInfoUpdate } from "./agent-sessions"
import { promptBlocks } from "./prompt-content"
import { answeredQuestionOutbound, shownAnswers } from "./translate/requests"
import {
  initialTranslateState,
  type AcpConnectionContext,
  type AcpOutbound,
  type TranslateState,
} from "./types"
import { errorNotificationOf, PUBLIC_ERRORS } from "./validation"

/**
 * Writes one connection's member events as ACP: `session/update` and `_aos/*`
 * notifications, and the server→client requests a paused turn asks. The
 * translators' reducer state lives here, one per turn stream.
 */

type Elicitation = Extract<AcpOutbound, { kind: "elicitation" }>["request"]

/**
 * Subtracting `sessionId` cannot reach inside the custom-mode variant's index
 * signature, so the outbound elicitation type carries one degenerate branch
 * that has lost its `mode`. Selecting the modes a translator actually produces
 * keeps the request assignable without widening what is sent.
 */
type ModedElicitation = Extract<Elicitation, { mode: string }>

function hasMode(request: Elicitation): request is ModedElicitation {
  return typeof request.mode === "string"
}

/** The vendor stop reasons that mean the turn failed rather than finished. */
const AOS_STOP_CODES: ReadonlySet<string> = new Set(
  Object.values(AOS_STOP_REASONS)
)

/** How much of a provider sentence one log line carries. */
const MAX_LOGGED_FAILURE_CHARS = 200

/**
 * The failure an idle `state_update` reports, when it reports one. Every other
 * update — including every streamed chunk — falls out on the first check. A
 * stop reason names the class of failure and nothing else, so the machine code
 * and the provider's sentence travel with it: they are what an operator
 * diagnoses one turn by. `errorCode` is the name `acp.error` already logs the
 * same classification under.
 */
function turnFailureOf(update: SessionUpdate) {
  if (!SessionUpdate.isStateUpdate(update) || !StateUpdate.isIdle(update))
    return undefined
  const stopReason = update.stopReason
  if (typeof stopReason !== "string" || !AOS_STOP_CODES.has(stopReason))
    return undefined
  const meta = AosStateMetaSchema.safeParse(update._meta?.[AOS_META_KEY])
  if (!meta.success) return { stopReason }
  const { turnId, code, message } = meta.data
  return {
    stopReason,
    turnId,
    ...(code === undefined ? {} : { errorCode: code }),
    ...(message === undefined
      ? {}
      : { message: message.slice(0, MAX_LOGGED_FAILURE_CHARS) }),
  }
}

/**
 * One `usage_update`. ACP's own fields carry the two token counts; everything
 * the provider reported about them travels in `_meta.aos`, which is what lets
 * the composer attribute the window instead of showing one opaque total.
 */
function usageUpdate(usage: SessionContextResponse): SessionUpdate {
  return {
    sessionUpdate: "usage_update",
    used: usage.usedTokens,
    size: usage.maxTokens,
    _meta: {
      [AOS_META_KEY]: {
        source: usage.source,
        ...(usage.estimated ? { estimated: usage.estimated } : {}),
        ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
      },
    },
  }
}

/**
 * The Session's execution as one `state_update`: the out-of-band report a
 * resume or an acknowledged Stop owes the client.
 */
function executionUpdate(
  state: SessionExecutionState,
  turnId: string | undefined,
  sequence: number
): SessionUpdate {
  const meta =
    turnId === undefined
      ? {}
      : {
          _meta: {
            [AOS_META_KEY]: {
              sequence,
              turnId,
              ...(state === "stopping"
                ? { execution: "stopping" as const }
                : {}),
            },
          },
        }
  if (state === "waiting-for-input")
    return { sessionUpdate: "state_update", state: "requires_action", ...meta }
  if (state === "running" || state === "stopping")
    return { sessionUpdate: "state_update", state: "running", ...meta }
  return {
    sessionUpdate: "state_update",
    state: "idle",
    ...(state === "uncertain"
      ? { stopReason: AOS_STOP_REASONS.uncertain }
      : {}),
    ...meta,
  }
}

/** One update of an older page, tagged with the cursor that asked for it. */
function pageUpdate(update: SessionUpdate, cursor: string): SessionUpdate {
  const meta = (update._meta ?? {}) as Record<string, unknown>
  const aos = meta[AOS_META_KEY]
  return {
    ...update,
    _meta: {
      ...meta,
      [AOS_META_KEY]: {
        ...(typeof aos === "object" ? aos : {}),
        historyPage: { cursor },
      },
    },
  }
}

export type MemberEncoderOptions = {
  context: AcpConnectionContext
  /** The connection's send port for client-side ACP methods. */
  client: AgentContext
  /** The seat a request is open on, while the Session is attached. */
  seat(sessionId: string): Seat | undefined
  /** Gives one answer through the member's stack. */
  answer(command: MemberCommands["answer"]): Promise<void>
}

export function createMemberEncoder({
  context,
  client,
  seat,
  answer,
}: MemberEncoderOptions): MemberConnection {
  const { translators } = context
  const states = new WeakMap<TurnStream, TranslateState>()
  /** The requests asked and not settled, by Session and requestId. */
  const asked = new Map<string, AbortController>()
  const askedKey = (sessionId: string, requestId: string) =>
    `${sessionId}\u0000${requestId}`

  function log(
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown>
  ) {
    context.logger?.[level](
      redactForLog({ event, connectionId: context.connectionId, ...fields })
    )
  }

  function update(sessionId: string, value: SessionUpdate) {
    const failure = turnFailureOf(value)
    if (failure) log("error", "acp.turn.failed", { sessionId, ...failure })
    return client.notify(methods.client.session.update, {
      sessionId,
      update: value,
    })
  }

  async function send(
    sessionId: string,
    outbound: AcpOutbound,
    sequence: number
  ) {
    switch (outbound.kind) {
      case "update":
        return update(sessionId, outbound.update)
      case "steer-accepted":
        return client.notify(AOS_METHODS.notify.steerAccepted, {
          sessionId,
          sequence,
          turnId: outbound.turnId,
          requestId: outbound.requestId,
          text: outbound.text,
          delivery: outbound.delivery,
        })
      case "composer-prefill":
        return client.notify(AOS_METHODS.notify.composerPrefill, {
          sessionId,
          turnId: outbound.turnId,
          text: outbound.text,
        })
      // The model reading restates the options, and a request is asked once
      // the Channel offers it.
      case "model-changed":
      case "request-permission":
      case "elicitation":
        return
    }
    return unhandledKind(outbound)
  }

  function fail(sessionId: string, cause: unknown) {
    return seat(sessionId)?.report(cause)
  }

  /** The open request one answer belongs to. */
  function answering(sessionId: string, requestId: string) {
    const attached = seat(sessionId)
    return attached && { request: attached.request(requestId) }
  }

  async function askPermission(
    sessionId: string,
    request: PendingRequest,
    signal: AbortSignal
  ) {
    const outbound = translators.pendingRequestToOutbound(request)
    if (outbound.kind !== "request-permission") return
    const response = await client.request(
      methods.client.session.requestPermission,
      { ...outbound.request, sessionId },
      { cancellationSignal: signal }
    )
    // An answer that crossed its withdrawal is no longer this member's to give.
    if (signal.aborted) return
    asked.delete(askedKey(sessionId, request.requestId))
    const target = answering(sessionId, request.requestId)
    if (!target) return
    await answer({
      sessionId,
      request: target.request,
      reply: translators.replyFromPermission(target.request, response),
    })
  }

  async function askElicitation(
    sessionId: string,
    request: PendingRequest,
    signal: AbortSignal
  ) {
    const outbound = translators.pendingRequestToOutbound(request)
    if (outbound.kind !== "elicitation") return
    if (!hasMode(outbound.request))
      throw new Error("The elicitation carries no mode")
    // An elicitation is scoped to a Session or to one request; this one is
    // both, so a client that reads either scope can still route it.
    const response = await client.request(
      methods.client.elicitation.create,
      { ...outbound.request, sessionId, requestId: request.requestId },
      { cancellationSignal: signal }
    )
    if (signal.aborted) return
    asked.delete(askedKey(sessionId, request.requestId))
    const target = answering(sessionId, request.requestId)
    if (!target) return
    await answer({
      sessionId,
      request: target.request,
      reply: translators.replyFromElicitation(target.request, response),
      answers: shownAnswers(target.request, response),
    })
  }

  /** Issues one server→client request and settles it as the member's answer. */
  function ask(sessionId: string, request: PendingRequest) {
    const controller = new AbortController()
    const { signal } = controller
    asked.set(askedKey(sessionId, request.requestId), controller)
    void (
      request.kind === PendingRequestKind.Permission
        ? askPermission(sessionId, request, signal)
        : askElicitation(sessionId, request, signal)
    ).catch((cause: unknown) =>
      // A withdrawn request is refused as cancelled, which is no failure.
      signal.aborted ? undefined : fail(sessionId, cause)
    )
  }

  /** Cancels a request the Session resolved, which is `$/cancel_request`. */
  function withdraw(sessionId: string, requestId: string) {
    const key = askedKey(sessionId, requestId)
    const controller = asked.get(key)
    if (!controller) return
    asked.delete(key)
    controller.abort()
  }

  async function turn(event: Extract<MemberEvent, { kind: "turn" }>) {
    const { sessionId, stream, sequence } = event
    const translated = translators.translateTurnEvent(
      states.get(stream) ?? {
        ...initialTranslateState,
        replayedCorrections: stream.replayedCorrections,
      },
      event.event,
      { turnId: stream.turnId, sequence, stopping: event.stopping }
    )
    states.set(stream, translated.state)
    for (const outbound of translated.outbound) {
      if (stream.dropped) return
      await send(sessionId, outbound, sequence)
    }
  }

  function historyOutbounds(event: Extract<MemberEvent, { kind: "history" }>) {
    return translators.translateHistory(event.page)
  }

  /**
   * An older page as tagged updates ahead of the reply. Only the newest page
   * carries the plan.
   */
  async function olderPage(
    event: Extract<MemberEvent, { kind: "history" }>,
    older: { cursor: string; offset: number }
  ) {
    const updates = historyOutbounds(event).flatMap((outbound) =>
      outbound.kind === "update" &&
      outbound.update.sessionUpdate !== "plan_update"
        ? [pageUpdate(outbound.update, older.cursor)]
        : []
    )
    for (const value of updates) await update(event.sessionId, value)
    log("info", "acp.history.page", {
      sessionId: event.sessionId,
      offset: older.offset,
      count: updates.length,
    })
  }

  /** Shows the member a prompt, as blocks rebuilt from its parts. */
  function prompt(event: Extract<MemberEvent, { kind: "prompt" }>) {
    return update(event.sessionId, {
      sessionUpdate: "user_message",
      messageId: event.messageId,
      content: promptBlocks(event.content),
    })
  }

  async function encode(event: MemberEvent): Promise<void> {
    const { sessionId } = event
    switch (event.kind) {
      case "turn":
        return turn(event)
      case "prompt":
        return prompt(event)
      case "history":
        if (event.older) return olderPage(event, event.older)
        for (const outbound of historyOutbounds(event))
          await send(sessionId, outbound, event.sequence)
        return
      case "request-asked":
        return ask(sessionId, event.request)
      case "request-withdrawn":
        return withdraw(sessionId, event.requestId)
      case "question-answered": {
        const record = answeredQuestionOutbound(event.request, event.answers)
        if (record) await send(sessionId, record, 0)
        return
      }
      case "execution":
        return update(
          sessionId,
          executionUpdate(event.state, event.turnId, event.sequence)
        )
      case "usage":
        return update(sessionId, usageUpdate(event.usage))
      case "model":
        // ACP restates the whole option set on a model switch.
        return update(sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: translators.configOptionsOf(event.models),
        })
      case "session-info":
        return update(sessionId, sessionInfoUpdate(event.row, event.status))
      case "commands":
        return update(sessionId, commandsUpdate(event.capabilities))
      case "invalidated":
        return client.notify(AOS_METHODS.notify.sessionInvalidated, {
          sessionId,
        })
      case "error": {
        const failure = errorNotificationOf(
          context.runtimeInstance.runtime,
          event.cause
        )
        log("error", "acp.error", {
          sessionId,
          errorCode: failure.code,
          message: failure.message,
        })
        // A turn that never started brackets itself as one that failed at
        // once, the way the browser already reads a run refused before
        // replying. Only a public code travels, as an `_aos/error` would on a
        // guest's socket, and no message, so the browser words the notice.
        if (event.turn) {
          const code = PUBLIC_ERRORS.notice(failure.code)
          await update(sessionId, {
            sessionUpdate: "state_update",
            state: "running",
            _meta: { [AOS_META_KEY]: event.turn },
          })
          return update(sessionId, {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: AOS_STOP_REASONS.error,
            _meta: { [AOS_META_KEY]: { ...event.turn, code } },
          })
        }
        await client
          .notify(AOS_METHODS.notify.error, { sessionId, ...failure })
          .catch(() => undefined)
        return
      }
    }
    return unhandledKind(event)
  }

  return {
    send: encode,
    // The upgrade's principal holds for the connection's whole life.
    live: () => context.authentication?.live() ?? true,
  }
}
