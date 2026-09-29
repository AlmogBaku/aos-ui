import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionUpdate,
  ToolCallLocation,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { MessageStatus, ThreadMessageLike } from "@assistant-ui/core"
import type { z } from "zod"

import {
  AOS_PLAN_ID,
  AOS_STOP_REASONS,
  AosArtifactDescriptorSchema,
  AosChunkMetaSchema,
  AosNoticeMetaSchema,
  AosPlanMetaSchema,
  AosStateMetaSchema,
  AosToolCallMetaSchema,
  AosTurnMetaSchema,
  parseArtifactUri,
} from "@aos/protocol/acp"

import { ARTIFACT_DATA_PART_NAME } from "@/artifacts/artifacts"
import {
  COMPACTION_DATA_PART_NAME,
  NOTICE_DATA_PART_NAME,
  type AosCompaction,
  type AosNotice,
} from "@/lib/message-parts"
import type { SessionStatus, TodoItem } from "@/runtime-adapters/contracts"

import { isSettledApproval, type AcpApproval } from "./acp-approvals"
import {
  appendBlock,
  appendData,
  appendToolContent,
  completeTiming,
  countChunk,
  findCall,
  isContentBlock,
  isRecord,
  isToolCallContent,
  latestAssistantId,
  mapCalls,
  patchToolCall,
  reopened,
  replaceBlocks,
  replaceData,
  startTiming,
  terminalIds,
  toolCallOwner,
  toThreadMessage,
  withChildMessage,
  withMessage,
  withStatus,
  type MessageRole,
  type ProjectedMessage,
  type ProjectedToolCall,
  type ToolCallPatch,
  type ToolMetaPatch,
} from "./projector-messages"
import {
  appendTerminal,
  snapshotTerminal,
  type TerminalStream,
} from "./projector-terminals"

/**
 * Folds one Session's ACP `session/update` stream into the state the Assistant
 * UI store reads: one projected message per wire message id, where a
 * `resource_link` naming an `artifact://` id lands as a message data part. The
 * thread reads each turn whole: the agent messages and thoughts between two
 * user messages show as one assistant message, in arrival order.
 * Pure and React-free: a replay starts from `initialProjectorState` and applies
 * the same reducer the live stream does.
 */

/**
 * The one shape a failed turn carries: the normalized `AOS_*` code the workspace
 * localizes, over the provider's own description. Lossless, so nothing has to be
 * stringified before the System Notice reads it.
 */
export type TurnFailure = {
  readonly code?: string
  readonly message?: string
  /** The provider and model that failed, shown as the notice's attribution. */
  readonly provider?: string
  readonly model?: string
}

export type ProjectorExecution = {
  readonly status: SessionStatus
  readonly turnId?: string
  /** When the running run started, as its own `state_update` reported it. */
  readonly startedAt?: number
  readonly stopReason?: string
  readonly error?: TurnFailure
}

export type ProjectorState = {
  readonly messages: readonly ProjectedMessage[]
  readonly execution: ProjectorExecution
  /** The turn the running run opened, and the only one its state settles. */
  readonly activeAssistantId?: string
  /**
   * The live turn that streamed while this view knew of no run: a resume sends
   * a running turn's stream ahead of the state that names it.
   */
  readonly streamedTurnId?: string
  readonly todos: readonly TodoItem[]
  readonly title?: string
  readonly configOptions?: readonly SessionConfigOption[]
  readonly commands?: readonly AvailableCommand[]
  /** Every terminal the run announced, whichever call shows it. */
  readonly terminals?: ReadonlyMap<string, TerminalStream>
  /**
   * Updates that arrived before the call they belong to, keyed by that call's
   * id, and applied the moment it appears.
   */
  readonly early?: ReadonlyMap<string, readonly EarlyUpdate[]>
  /**
   * The Session's permission requests, laid over the transcript when it is
   * read rather than folded into it, so a replay that clears the transcript
   * keeps them.
   */
  readonly approvals?: readonly AcpApproval[]
  /** The turn each approval was first seen beside, by approval id. */
  readonly approvalHosts?: ReadonlyMap<string, string>
  /**
   * Monotonically increasing across rebuilds, so `aos-notice-<n>` ids never
   * collide when the transcript is cleared and notices arrive again.
   */
  readonly noticeCounter?: number
}

type EarlyUpdate = { readonly update: SessionUpdate; readonly meta: unknown }

export const initialProjectorState: ProjectorState = {
  messages: [],
  execution: { status: "idle" },
  todos: [],
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** The wire's own instant as epoch ms; the schema validated its format. */
const epochOf = (at: string | undefined) =>
  at === undefined ? undefined : Date.parse(at)

/** Omitted or ill-typed keeps, `null` clears, a string replaces. */
const textPatch = (value: unknown) =>
  typeof value === "string" ? value : value === null ? null : undefined

const listOf = <T>(
  value: unknown,
  isItem: (item: unknown) => item is T
): readonly T[] | undefined =>
  Array.isArray(value) && value.every(isItem) ? value : undefined

const blockPatch = (value: unknown) =>
  value === null ? null : listOf(value, isContentBlock)

const isConfigOption = (value: unknown): value is SessionConfigOption =>
  isRecord(value) &&
  typeof value.type === "string" &&
  typeof value.configId === "string" &&
  typeof value.name === "string"

const isCommand = (value: unknown): value is AvailableCommand =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.description === "string"

const roleOf = (kind: string): MessageRole =>
  kind.startsWith("user_") ? "user" : "assistant"

const sourceOf = (kind: string) =>
  kind.startsWith("agent_thought") ? "thought" : "message"

function withMessages(
  state: ProjectorState,
  messages: readonly ProjectedMessage[]
): ProjectorState {
  return messages === state.messages ? state : { ...state, messages }
}

/**
 * Upserts the named message, creating it with `role` when it is new, and the
 * one place a turn's status is opened. An assistant turn a running run creates
 * is born running, and either way the turn the run creates becomes the one its
 * later state settles — so a run that has written nothing yet never re-opens the
 * finished turn behind it, and an empty turn synthesized to host this run's
 * interrupt is taken over rather than left beside the answer it asked for.
 */
function onMessage(
  state: ProjectorState,
  id: string,
  role: MessageRole,
  patch: (message: ProjectedMessage) => ProjectedMessage
): ProjectorState {
  const fresh =
    role === "assistant" && !state.messages.some((message) => message.id === id)
  const host = fresh ? emptyRequestHostId(state) : undefined
  // Re-keying the host keeps its place and the pending status it carries; the
  // run's own state settles it under the id the provider streamed.
  const renamed = host === undefined ? state : renameMessage(state, host, id)
  const opened = fresh && state.execution.status === "running"
  // A run moves on from the turn it had open only when that turn was one a
  // resume reopened, so that turn has written all it will.
  const prior = opened ? activeAssistantId(renamed) : undefined
  const source =
    prior === undefined
      ? renamed
      : withMessages(
          renamed,
          withMessage(renamed.messages, prior, "assistant", (message) =>
            withStatus(message, { type: "complete", reason: "stop" })
          )
        )
  const next = withMessages(
    source,
    withMessage(source.messages, id, role, (message) =>
      patch(opened ? opening(message, state.execution) : message)
    )
  )
  return opened || host !== undefined
    ? { ...next, activeAssistantId: id }
    : next
}

/**
 * The status and the span a turn a running run opens is born with. The run's own
 * `state_update` timed it, so a replayed turn is timed exactly as the live one
 * was; a run that started without a reported moment leaves its turns untimed.
 */
function opening(
  message: ProjectedMessage,
  execution: ProjectorExecution
): ProjectedMessage {
  const running = withStatus(message, { type: "running" })
  const { startedAt } = execution
  return startedAt === undefined ? running : startTiming(running, startedAt)
}

/** The turn the run opened, while it is still part of the projection. */
function activeAssistantId(state: ProjectorState): string | undefined {
  const id = state.activeAssistantId
  return id !== undefined && state.messages.some((message) => message.id === id)
    ? id
    : undefined
}

/** The optimistic user turn a prompt shows before the provider echoes it. */
export const LOCAL_PROMPT_PREFIX = "aos-local-"

const REQUEST_HOST_PREFIX = "aos-request-"

/** A request before the turn's first update still needs a message to host it. */
const requestHostId = (turnId: string | undefined) =>
  `${REQUEST_HOST_PREFIX}${turnId ?? "current"}`

/**
 * The hosted turn the run's own first turn takes over: one this projection
 * synthesized for a request and the run has written nothing into. A host
 * that already carries content is the run's turn, so it stays where it is.
 */
function emptyRequestHostId(state: ProjectorState): string | undefined {
  const id = state.activeAssistantId
  if (id === undefined || !id.startsWith(REQUEST_HOST_PREFIX)) return undefined
  const host = state.messages.find((message) => message.id === id)
  return host?.parts.every(isCompaction) ? id : undefined
}

/** A compaction the host shows ahead of the run's turn moves with it. */
const isCompaction = (part: ProjectedMessage["parts"][number]) =>
  part.source === "data" && part.name === COMPACTION_DATA_PART_NAME

/**
 * A tool call belongs to the turn that already holds it: a provider settles a
 * call it opened in an earlier run segment — the answered question is the one
 * that waits longest — and the update naming that turn is the one thing it can
 * no longer name. Its id is enough, so the owner is resolved first, and nothing
 * arrives twice under two titles. `_meta.aos` places a call this transcript has
 * not seen yet; without it, the latest turn.
 */
function applyToolCall(
  state: ProjectorState,
  update: SessionUpdate,
  meta: unknown
): ProjectorState {
  const patch = toolPatch(update)
  if (!patch) return state
  const parsed = AosToolCallMetaSchema.safeParse(meta)
  const aos = parsed.success ? parsed.data : undefined
  const toolMeta = toolMetaPatch(aos)
  const owner = toolCallOwner(state.messages, patch.toolCallId)
  // A subagent's call nests under the call that spawned it; one already
  // projected is patched where it is, however the update attributes it.
  if (!owner && aos?.subagentId !== undefined)
    return applyChild(state, { update, meta }, aos, aos.messageId, (message) =>
      patchToolCall(message, patch, toolMeta)
    )
  const named =
    owner?.id ?? (aos ? aos.messageId : latestAssistantId(state.messages))
  if (named === undefined) return state
  return onMessage(state, named, "assistant", (message) =>
    patchToolCall(message, patch, toolMeta)
  )
}

type ToolMeta = z.infer<typeof AosToolCallMetaSchema>

function toolMetaPatch(aos: ToolMeta | undefined): ToolMetaPatch {
  if (!aos) return {}
  return {
    argsText: aos.argsText,
    argsTextDelta: aos.argsTextDelta,
    startedAt: epochOf(aos.startedAt),
    completedAt: epochOf(aos.completedAt),
    durationMs: aos.durationMs,
    subagent: aos.subagent,
    ...(aos.app ? { app: true as const } : {}),
  }
}

const SUBAGENT_CALL_PREFIX = "aos-subagent-"

/**
 * Applies what a subagent produced inside its own turn, under the call that
 * spawned it. A named spawning call not seen yet holds the update until it
 * appears; a subagent whose spawning call the stream never names gets one, so
 * its work still reads under a call rather than as the turn's own.
 */
function applyChild(
  state: ProjectorState,
  pending: EarlyUpdate,
  attribution: { subagentId?: string; parentToolCallId?: string },
  hostId: string,
  patch: (message: ProjectedMessage) => ProjectedMessage
): ProjectorState {
  const { subagentId, parentToolCallId } = attribution
  if (subagentId === undefined) return state
  const spawn = findCall(state.messages, (call) =>
    parentToolCallId === undefined
      ? call.subagent?.id === subagentId
      : call.toolCallId === parentToolCallId
  )
  if (!spawn && parentToolCallId !== undefined)
    return holdEarly(state, parentToolCallId, pending)
  const spawnId = spawn?.toolCallId ?? `${SUBAGENT_CALL_PREFIX}${subagentId}`
  const hosted = spawn
    ? state
    : onMessage(state, hostId, "assistant", (message) =>
        patchToolCall(
          message,
          { toolCallId: spawnId, name: "subagent", status: "in_progress" },
          { subagent: { id: subagentId } }
        )
      )
  const owner = toolCallOwner(hosted.messages, spawnId)
  if (!owner) return state
  return onMessage(hosted, owner.id, owner.role, (message) =>
    mapCalls(message, (call) =>
      call.toolCallId === spawnId
        ? withChildMessage(call, subagentId, patch)
        : call
    )
  )
}

function holdEarly(
  state: ProjectorState,
  toolCallId: string,
  pending: EarlyUpdate
): ProjectorState {
  const early = new Map(state.early)
  early.set(toolCallId, [...(early.get(toolCallId) ?? []), pending])
  return { ...state, early }
}

/** Applies what waited for the call, now that it is projected. */
function flushEarly(state: ProjectorState, toolCallId: string): ProjectorState {
  const pending = state.early?.get(toolCallId)
  if (!pending || !toolCallOwner(state.messages, toolCallId)) return state
  const early = new Map(state.early)
  early.delete(toolCallId)
  return pending.reduce<ProjectorState>(
    (next, { update, meta }) => applyUpdate(next, update, meta),
    { ...state, early: early.size === 0 ? undefined : early }
  )
}

/**
 * Re-reads the terminals of the calls that match, so a call re-renders as its
 * terminal streams; a call whose terminals did not change keeps its identity.
 */
function stampTerminals(
  state: ProjectorState,
  matches: (call: ProjectedToolCall) => boolean
): ProjectorState {
  const { terminals } = state
  if (!terminals) return state
  const stamp = (call: ProjectedToolCall) => {
    if (!matches(call)) return call
    const views = terminalIds(call).flatMap((id) => {
      const stream = terminals.get(id)
      return stream ? [stream.view] : []
    })
    const current = call.terminals ?? []
    const same =
      views.length === current.length &&
      views.every((view, index) => view === current[index])
    return same ? call : { ...call, terminals: views }
  }
  return withMessages(
    state,
    state.messages.map((message) => mapCalls(message, stamp))
  )
}

function applyTerminal(
  state: ProjectorState,
  kind: "terminal_update" | "terminal_output_chunk",
  update: UpdatePayload
): ProjectorState {
  const terminalId = text(update.terminalId)
  if (terminalId === undefined) return state
  const current = state.terminals?.get(terminalId)
  const data = text(update.data)
  const stream =
    kind === "terminal_update"
      ? snapshotTerminal(current, terminalId, update)
      : data === undefined
        ? undefined
        : appendTerminal(current, terminalId, data)
  if (!stream) return state
  const terminals = new Map(state.terminals)
  terminals.set(terminalId, stream)
  return stampTerminals({ ...state, terminals }, (call) =>
    terminalIds(call).includes(terminalId)
  )
}

const COMPACTION_STATUS = new Map<string, AosCompaction["status"]>([
  ["in_progress", "started"],
  ["completed", "completed"],
  ["failed", "failed"],
])

const compactionOf = (id: string) => (name: string, data: unknown) =>
  name === COMPACTION_DATA_PART_NAME &&
  isRecord(data) &&
  data.compactionId === id

/**
 * A compaction reads where it happened: at first sight it takes its place
 * among the turn's parts, and every later report updates that one divider. A
 * cancelled one compacted nothing, so its divider leaves the turn.
 */
function applyCompaction(
  state: ProjectorState,
  update: UpdatePayload,
  meta: unknown
): ProjectorState {
  const compactionId = text(update.compactionId)
  if (compactionId !== undefined && update.status === "cancelled")
    return withoutCompaction(state, compactionId)
  const status = COMPACTION_STATUS.get(text(update.status) ?? "")
  if (compactionId === undefined || status === undefined) return state
  const summary = listOf(update.summary, isContentBlock)
    ?.flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
  const error = text(update.error)
  const data: AosCompaction = {
    compactionId,
    status,
    ...(summary ? { summary } : {}),
    ...(error === undefined ? {} : { error }),
  }
  const matches = compactionOf(compactionId)
  const placed = state.messages.find((message) =>
    message.parts.some(
      (part) => part.source === "data" && matches(part.name, part.data)
    )
  )
  if (placed)
    return onMessage(state, placed.id, placed.role, (message) =>
      replaceData(message, matches, data)
    )
  const parsed = AosTurnMetaSchema.safeParse(meta)
  const turnId = parsed.success ? parsed.data.turnId : state.execution.turnId
  const id =
    activeAssistantId(state) ??
    (state.execution.status === "running"
      ? undefined
      : latestAssistantId(state.messages)) ??
    requestHostId(turnId)
  return onMessage(state, id, "assistant", (message) =>
    appendData(message, COMPACTION_DATA_PART_NAME, data)
  )
}

function withoutCompaction(
  state: ProjectorState,
  compactionId: string
): ProjectorState {
  const matches = compactionOf(compactionId)
  const placed = (part: ProjectedMessage["parts"][number]) =>
    part.source === "data" && matches(part.name, part.data)
  if (!state.messages.some((message) => message.parts.some(placed)))
    return state
  return withMessages(
    state,
    state.messages.map((message) =>
      message.parts.some(placed)
        ? { ...message, parts: message.parts.filter((part) => !placed(part)) }
        : message
    )
  )
}

const NOTICE_SEVERITY = new Set<string>(["info", "warning", "error"])

const noticeSeverity = (raw: string | undefined): AosNotice["severity"] =>
  raw !== undefined && NOTICE_SEVERITY.has(raw)
    ? (raw as AosNotice["severity"])
    : "info"

/**
 * A status the proxy announces live: attaches to the active assistant turn
 * while a run is under way, or to the latest assistant message while idle
 * (so `resumed()` cannot reopen a notice message as the next turn). When
 * the thread holds no assistant message yet a standalone `aos-notice-<n>`
 * is created instead. A consecutive duplicate — same kind and title as the
 * last part of the target message — is dropped.
 */
function applyNotice(
  state: ProjectorState,
  update: UpdatePayload,
  meta: unknown
): ProjectorState {
  const title = text(update.title)
  if (!title) return state
  const severity = noticeSeverity(text(update.severity))
  const description = text(update.description)
  const parsed = AosNoticeMetaSchema.safeParse(meta)
  const kind = parsed.success ? parsed.data.kind : undefined
  const data: AosNotice = {
    severity,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(kind !== undefined ? { kind } : {}),
  }
  const counter = (state.noticeCounter ?? 0) + 1
  const withCounter: ProjectorState = { ...state, noticeCounter: counter }
  const isRunning = state.execution.status === "running"
  const id = isRunning
    ? (activeAssistantId(state) ?? requestHostId(state.execution.turnId))
    : (latestAssistantId(state.messages) ?? `aos-notice-${counter}`)
  // Drop a consecutive duplicate at the same location.
  const target = state.messages.find((m) => m.id === id)
  const lastPart = target?.parts.at(-1)
  if (
    lastPart?.source === "data" &&
    lastPart.name === NOTICE_DATA_PART_NAME &&
    isRecord(lastPart.data) &&
    lastPart.data.kind === data.kind &&
    lastPart.data.title === data.title
  ) return state
  return onMessage(withCounter, id, "assistant", (message) =>
    appendData(message, NOTICE_DATA_PART_NAME, data)
  )
}

/** The vendor stop reasons carry the failure the run reported. */
function errorFrom(aos: TurnFailure | undefined): TurnFailure | undefined {
  const error: TurnFailure = {
    ...(aos?.code === undefined ? {} : { code: aos.code }),
    ...(aos?.message === undefined ? {} : { message: aos.message }),
    ...(aos?.provider === undefined ? {} : { provider: aos.provider }),
    ...(aos?.model === undefined ? {} : { model: aos.model }),
  }
  return error.code === undefined && error.message === undefined
    ? undefined
    : error
}

/**
 * The final failure a still-running run already reported, which it keeps until
 * it ends however it ends: a run awaiting Stop reports its failure first.
 */
function reportedFailure(
  state: ProjectorState,
  turnId: string | undefined
): TurnFailure | undefined {
  const { execution } = state
  return execution.status === "running" && execution.turnId === turnId
    ? execution.error
    : undefined
}

/**
 * A run that reports a final failure but stays active until it is stopped. The
 * failure reads on the turn the run opened, or on a hosted one when it opened
 * none, and the Session stays running so Stop remains available.
 */
function applyRunningFailure(
  state: ProjectorState,
  carried: { turnId?: string },
  error: TurnFailure
): ProjectorState {
  const id = activeAssistantId(state) ?? requestHostId(carried.turnId)
  const failing: ProjectorState = {
    ...state,
    execution: { ...state.execution, status: "running", ...carried, error },
  }
  return {
    ...onMessage(failing, id, "assistant", (message) =>
      withStatus(message, { type: "incomplete", reason: "error", error })
    ),
    activeAssistantId: id,
  }
}

type IncompleteReason = Extract<MessageStatus, { type: "incomplete" }>["reason"]

/** The ACP stop reasons that end a turn short of its answer. */
const STOP_INCOMPLETE = new Map<string, IncompleteReason>([
  ["cancelled", "cancelled"],
  ["max_tokens", "length"],
  ["refusal", "content-filter"],
  ["max_turn_requests", "other"],
])

function applyIdle(
  state: ProjectorState,
  carried: { turnId?: string },
  stopReason: string | undefined,
  aos: (TurnFailure & { at?: string }) | undefined
): ProjectorState {
  const reported = reportedFailure(state, carried.turnId)
  const failed =
    reported !== undefined ||
    stopReason === AOS_STOP_REASONS.error ||
    stopReason === AOS_STOP_REASONS.uncertain
  const error = reported ?? (failed ? errorFrom(aos) : undefined)
  const execution: ProjectorExecution = {
    status: failed ? "failed" : "idle",
    ...carried,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(error === undefined ? {} : { error }),
  }
  const incomplete = STOP_INCOMPLETE.get(stopReason ?? "")
  const status: MessageStatus = failed
    ? { type: "incomplete", reason: "error", ...(error && { error }) }
    : incomplete
      ? { type: "incomplete", reason: incomplete }
      : { type: "complete", reason: "stop" }
  // The turn this run opened ends where the wire says the run did; a moment it
  // did not report leaves the turn's span as open as it was.
  const completedAt = epochOf(aos?.at)
  const id = activeAssistantId(state)
  // A run that wrote no turn settles the Session alone: the history before it
  // keeps the status it was projected with. Whatever still waits for a call
  // the run never announced is dropped with it.
  const settled: ProjectorState = {
    ...state,
    execution,
    activeAssistantId: undefined,
    early: undefined,
  }
  return id === undefined
    ? settled
    : onMessage(settled, id, "assistant", (message) =>
        withStatus(
          completedAt === undefined
            ? message
            : completeTiming(message, completedAt),
          status
        )
      )
}

/**
 * The start the same turn's run already recorded while it is still under way,
 * so a repeated or resumed state that reports no moment keeps it.
 */
function ongoingStart(
  state: ProjectorState,
  turnId: string | undefined
): number | undefined {
  const { status, startedAt } = state.execution
  const ongoing = status === "running" || status === "waiting-for-input"
  return ongoing && state.execution.turnId === turnId ? startedAt : undefined
}

/**
 * A run restated as running, with no moment of its own, after this projection
 * saw it settle: a view rebuilt from history mid-turn, where the replay closes
 * the live turn's stored part like any other. A live run shows its prompt
 * first, so a transcript that still ends on an assistant turn ends on this
 * run's, and that turn reopens as the one the run's state settles.
 */
function resumed(before: ProjectorState, running: ProjectorState) {
  const { status } = before.execution
  const ongoing = status === "running" || status === "waiting-for-input"
  const last = before.messages.at(-1)
  if (ongoing || activeAssistantId(before) !== undefined) return running
  if (last?.role !== "assistant") return running
  return {
    ...onMessage(running, last.id, "assistant", reopened),
    activeAssistantId: last.id,
  }
}

/**
 * A resumed run's state, arriving after the stream it already sent: a
 * transcript that ends on an assistant turn ends on this run's, which opens
 * timed from where the run began.
 */
function announced(before: ProjectorState, running: ProjectorState) {
  const last = before.messages.at(-1)
  if (last?.role !== "assistant") return running
  return {
    ...onMessage(running, last.id, "assistant", (message) =>
      opening(message, running.execution)
    ),
    activeAssistantId: last.id,
  }
}

/** Notes a live turn streaming while this view knows of no run. */
function noteStreamedTurn(state: ProjectorState, meta: unknown) {
  const { status } = state.execution
  if (status === "running" || status === "waiting-for-input") return state
  const parsed = AosTurnMetaSchema.safeParse(meta)
  const turnId = parsed.success ? parsed.data.turnId : undefined
  return turnId === undefined || turnId === state.streamedTurnId
    ? state
    : { ...state, streamedTurnId: turnId }
}

function applyState(
  state: ProjectorState,
  update: UpdatePayload,
  meta: unknown
): ProjectorState {
  const parsed = AosStateMetaSchema.safeParse(meta)
  const aos = parsed.success ? parsed.data : undefined
  const turnId = aos?.turnId ?? state.execution.turnId
  const carried = turnId === undefined ? {} : { turnId }
  const next = text(update.state)
  // The run owns no turn until one of its updates opens one, so starting only
  // moves the Session's own status — and records the moment every turn this run
  // opens is timed from.
  if (next === "running") {
    const failure = errorFrom(aos)
    if (failure) return applyRunningFailure(state, carried, failure)
    const startedAt = epochOf(aos?.at) ?? ongoingStart(state, turnId)
    const reported = reportedFailure(state, turnId)
    const running: ProjectorState = {
      ...state,
      execution: {
        status: "running",
        ...carried,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(reported === undefined ? {} : { error: reported }),
      },
    }
    if (aos?.at === undefined) return resumed(state, running)
    return state.streamedTurnId === turnId ? announced(state, running) : running
  }
  if (next === "requires_action") {
    const startedAt = ongoingStart(state, turnId)
    const blocked: ProjectorState = {
      ...state,
      execution: {
        status: "waiting-for-input",
        ...carried,
        ...(startedAt === undefined ? {} : { startedAt }),
      },
    }
    // A wait this projection did not watch start is a replayed one: its turn is
    // already in the transcript and owns the request. A live run that asks
    // before writing anything owns no turn yet, so that one is hosted.
    const replayed = state.execution.status !== "running"
    const id =
      activeAssistantId(state) ??
      (replayed ? latestAssistantId(state.messages) : undefined) ??
      requestHostId(turnId)
    return {
      ...onMessage(blocked, id, "assistant", (message) =>
        withStatus(message, { type: "requires-action", reason: "interrupt" })
      ),
      activeAssistantId: id,
    }
  }
  if (next !== "idle") return state
  return applyIdle(state, carried, text(update.stopReason), aos)
}

/**
 * The thread's turns: each user message alone, and each run of agent messages
 * and thoughts between two of them as one, in arrival order, as Hermes Desktop
 * groups a turn. The group goes by its first message's id.
 */
function turnsOf(
  messages: readonly ProjectedMessage[]
): readonly (readonly ProjectedMessage[])[] {
  const turns: ProjectedMessage[][] = []
  for (const message of messages) {
    const last = turns.at(-1)
    if (message.role === "assistant" && last?.[0]?.role === "assistant")
      last.push(message)
    else turns.push([message])
  }
  return turns
}

const grouped = new WeakMap<
  ProjectedMessage,
  { members: readonly ProjectedMessage[]; value: ProjectedMessage }
>()

/**
 * One turn's messages as the one message the thread shows, memoized by its
 * members, so a turn nothing touched keeps its identity.
 */
function turnMessage(members: readonly ProjectedMessage[]): ProjectedMessage {
  const [first] = members
  if (members.length === 1) return first!
  const cached = grouped.get(first!)
  if (cached && sameMembers(cached.members, members)) return cached.value
  const value = merged(first!.id, members)
  grouped.set(first!, { members, value })
  return value
}

const sameMembers = (
  left: readonly ProjectedMessage[],
  right: readonly ProjectedMessage[]
) =>
  left.length === right.length &&
  left.every((message, index) => message === right[index])

/**
 * One turn out of the messages it groups, spanning all of them: it runs while
 * its latest message does, so it stays open until the run's `idle`.
 */
function merged(
  id: string,
  members: readonly ProjectedMessage[]
): ProjectedMessage {
  const [first] = members
  const last = members.at(-1)
  const timed = members.flatMap((message) =>
    message.timing ? [message.timing] : []
  )
  const [start] = timed
  const completedAt = timed.at(-1)?.completedAt
  return {
    id,
    role: first!.role,
    parts: members.flatMap((message) => message.parts),
    ...(last?.status === undefined ? {} : { status: last.status }),
    ...(start === undefined
      ? {}
      : {
          timing: {
            startedAt: start.startedAt,
            ...(completedAt === undefined ? {} : { completedAt }),
            chunks: timed.reduce((sum, timing) => sum + timing.chunks, 0),
          },
        }),
  }
}

/** Only the Session's own plan is projected, and `_meta.aos` carries it. */
function applyPlan(
  state: ProjectorState,
  update: UpdatePayload,
  meta: unknown
): ProjectorState {
  const plan = isRecord(update.plan) ? update.plan : undefined
  if (plan?.planId !== AOS_PLAN_ID) return state
  const parsed = AosPlanMetaSchema.safeParse(meta)
  return parsed.success ? { ...state, todos: parsed.data.todos } : state
}

/**
 * ACP's update union stays open, so a kind never guarantees its payload's
 * shape: every field is read back as `unknown` and validated here.
 */
type UpdatePayload = Record<string, unknown>

function applyWhole(
  state: ProjectorState,
  kind: string,
  update: UpdatePayload
): ProjectorState {
  const messageId = text(update.messageId)
  if (messageId === undefined) return state
  const blocks = blockPatch(update.content)
  // A prompt echo names the images it attached as artifacts, which show the
  // way the same turn does once history replays it.
  const artifacts = (blocks ?? []).flatMap((block) => {
    const artifact = linkedArtifact(block)
    return artifact ? [artifact] : []
  })
  return onMessage(state, messageId, roleOf(kind), (message) =>
    artifacts.reduce(
      (next, artifact) =>
        carriesArtifact(next, artifact.id)
          ? next
          : appendData(next, ARTIFACT_DATA_PART_NAME, artifact),
      replaceBlocks(
        message,
        sourceOf(kind),
        blocks && blocks.filter((block) => !linkedArtifact(block))
      )
    )
  )
}

/**
 * The artifact a published link names, or `undefined` for an ordinary link. The
 * id is all the link carries: the artifact resolver reads it through the Session
 * and listener this client already holds, never from a location on the wire.
 */
function linkedArtifact(block: ContentBlock) {
  if (block.type !== "resource_link" || typeof block.uri !== "string")
    return undefined
  const id = parseArtifactUri(block.uri)
  if (id === undefined) return undefined
  const artifact = AosArtifactDescriptorSchema.safeParse({
    id,
    filename: block.name,
    ...(block.mimeType == null ? {} : { mimeType: block.mimeType }),
    ...(block.size == null ? {} : { sizeBytes: block.size }),
    source: { type: "provider", reference: id },
  })
  return artifact.success ? artifact.data : undefined
}

function applyChunk(
  state: ProjectorState,
  update: SessionUpdate & UpdatePayload,
  meta: unknown
): ProjectorState {
  const kind = update.sessionUpdate
  const named = text(update.messageId)
  const block = update.content
  if (named === undefined || !isContentBlock(block)) return state
  const aos = AosChunkMetaSchema.safeParse(meta)
  if (aos.success && aos.data.subagentId !== undefined)
    return applyChild(state, { update, meta }, aos.data, named, (message) =>
      appendBlock(message, sourceOf(kind), block)
    )
  const artifact = linkedArtifact(block)
  return onMessage(state, named, roleOf(kind), (message) =>
    artifact === undefined
      ? countChunk(appendBlock(message, sourceOf(kind), block))
      : carriesArtifact(message, artifact.id)
        ? message
        : appendData(message, ARTIFACT_DATA_PART_NAME, artifact)
  )
}

const isLocation = (value: unknown): value is ToolCallLocation =>
  isRecord(value) && typeof value.path === "string"

function toolPatch(update: UpdatePayload): ToolCallPatch | undefined {
  const toolCallId = text(update.toolCallId)
  if (toolCallId === undefined) return undefined
  return {
    toolCallId,
    name: textPatch(update.name),
    title: textPatch(update.title),
    kind: textPatch(update.kind),
    status: textPatch(update.status),
    content:
      update.content === null
        ? null
        : listOf(update.content, isToolCallContent),
    locations:
      update.locations === null ? null : listOf(update.locations, isLocation),
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
  }
}

/** Partial output appends; output ahead of its call waits for it. */
function applyToolContent(
  state: ProjectorState,
  update: SessionUpdate & UpdatePayload,
  meta: unknown
): ProjectorState {
  const toolCallId = text(update.toolCallId)
  const content = update.content
  if (toolCallId === undefined || !isToolCallContent(content)) return state
  const owner = toolCallOwner(state.messages, toolCallId)
  if (!owner) return holdEarly(state, toolCallId, { update, meta })
  return onMessage(state, owner.id, owner.role, (message) =>
    appendToolContent(message, toolCallId, content)
  )
}

/** A call's update also re-reads its terminals and releases what waited. */
function afterToolCall(
  state: ProjectorState,
  update: UpdatePayload
): ProjectorState {
  const toolCallId = text(update.toolCallId)
  if (toolCallId === undefined) return state
  const stamped = stampTerminals(
    state,
    (call) => call.toolCallId === toolCallId
  )
  return flushEarly(stamped, toolCallId)
}

function applyTitle(
  state: ProjectorState,
  update: UpdatePayload
): ProjectorState {
  const title = textPatch(update.title)
  if (title === undefined) return state
  return title === null ? { ...state, title: undefined } : { ...state, title }
}

/** `meta` is the update's `_meta.aos`; unknown kinds and payloads are ignored. */
export function applyUpdate(
  state: ProjectorState,
  update: SessionUpdate,
  meta: unknown
): ProjectorState {
  const next = applyKind(state, update, meta)
  if (update.sessionUpdate === "state_update")
    return next.streamedTurnId === undefined
      ? next
      : { ...next, streamedTurnId: undefined }
  return next.messages === state.messages ? next : noteStreamedTurn(next, meta)
}

function applyKind(
  state: ProjectorState,
  update: SessionUpdate,
  meta: unknown
): ProjectorState {
  const kind = update.sessionUpdate
  switch (kind) {
    case "user_message":
    case "agent_message":
    case "agent_thought":
      return applyWhole(state, kind, update)
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return applyChunk(state, update, meta)
    case "tool_call_update":
      return afterToolCall(applyToolCall(state, update, meta), update)
    case "tool_call_content_chunk":
      return afterToolCall(applyToolContent(state, update, meta), update)
    case "terminal_update":
    case "terminal_output_chunk":
      return applyTerminal(state, kind, update)
    case "compaction_update":
      return applyCompaction(state, update, meta)
    case "notice":
      return applyNotice(state, update, meta)
    case "state_update":
      return applyState(state, update, meta)
    case "plan_update":
      return applyPlan(state, update, meta)
    // Usage belongs to the composer's Session projection, not the transcript.
    case "session_info_update":
      return applyTitle(state, update)
    case "config_option_update": {
      const configOptions = listOf(update.configOptions, isConfigOption)
      return configOptions ? { ...state, configOptions } : state
    }
    case "available_commands_update": {
      const commands = listOf(update.availableCommands, isCommand)
      return commands ? { ...state, commands } : state
    }
    default:
      return state
  }
}

/**
 * Whether this turn already carries the artifact. A replay re-grants every
 * artifact the transcript stored, so one publication lands on its turn once
 * however often the proxy announces it.
 */
function carriesArtifact(message: ProjectedMessage, id: string) {
  return message.parts.some(
    (part) =>
      part.source === "data" &&
      part.name === ARTIFACT_DATA_PART_NAME &&
      isRecord(part.data) &&
      part.data.id === id
  )
}

/**
 * Re-keys the optimistic user turn onto the id the proxy assigned it. The echo
 * may arrive first, in which case the local copy is dropped instead.
 */
export function renameMessage(
  state: ProjectorState,
  fromId: string,
  toId: string
): ProjectorState {
  const current = state.messages.find((message) => message.id === fromId)
  if (!current || fromId === toId) return state
  const taken = state.messages.some((message) => message.id === toId)
  return withMessages(
    state,
    taken
      ? state.messages.filter((message) => message !== current)
      : state.messages.map((message) =>
          message === current ? { ...message, id: toId } : message
        )
  )
}

/**
 * The turns a replay that resends the whole Session replaces, as it starts.
 * A prompt the provider has not echoed yet is the browser's alone: a draft's
 * first turn binds and resumes while its own prompt is in flight, and the reply
 * re-keys it onto the id the proxy assigned, which drops it if the replay
 * already carried that turn.
 */
export function replacedTurns(state: ProjectorState): ReadonlySet<string> {
  return new Set(
    state.messages.flatMap((message) =>
      message.id.startsWith(LOCAL_PROMPT_PREFIX) ? [] : [message.id]
    )
  )
}

/**
 * Drops the turns a replay replaces. The replay's parts arrive as chunks, so
 * the ones already projected would be doubled rather than replaced; the
 * Session's own state stays, because the replay restates that itself.
 */
export function clearTranscript(
  state: ProjectorState,
  replaced = replacedTurns(state)
): ProjectorState {
  const kept = state.messages.filter((message) => !replaced.has(message.id))
  const bare = !state.terminals && !state.early
  if (kept.length === state.messages.length && bare) return state
  return {
    ...state,
    messages: kept,
    activeAssistantId: undefined,
    terminals: undefined,
    early: undefined,
  }
}

/**
 * Puts an older page's turns ahead of the transcript. A turn that landed
 * between two reads can sit on both pages, so a turn the thread already holds
 * keeps its current copy and the page's is skipped.
 */
export function prependMessages(
  state: ProjectorState,
  older: readonly ProjectedMessage[]
): ProjectorState {
  const known = new Set(state.messages.map((message) => message.id))
  const unseen = older.filter((message) => !known.has(message.id))
  return unseen.length === 0
    ? state
    : withMessages(state, [...unseen, ...state.messages])
}

/**
 * Keeps the listed turns in order; the runtime's removals flow back here. A
 * turn goes by its first message's id, and keeps every message it groups.
 */
export function retainMessages(
  state: ProjectorState,
  ids: readonly string[]
): ProjectorState {
  const keep = new Set(ids)
  const messages = turnsOf(state.messages).flatMap((members) =>
    keep.has(members[0]!.id) ? members : []
  )
  return messages.length === state.messages.length
    ? state
    : { ...state, messages }
}

/**
 * Reports a turn that failed without a reply of its own: one the provider
 * refused, or a run that failed before it wrote anything. The failure reads
 * beside the Session's latest answer — the host a wait no run owns already
 * uses — and a turn already awaiting the operator keeps the status it is
 * waiting with.
 */
export function failLatestTurn(
  state: ProjectorState,
  error: TurnFailure | undefined
): ProjectorState {
  // A thread with no turn yet — a draft whose Session could not be created —
  // hosts the failure on a turn of its own, which the first replay clears.
  const id = latestAssistantId(state.messages) ?? requestHostId("refused")
  const host = state.messages.find((message) => message.id === id)
  if (host?.status?.type === "requires-action") return state
  return onMessage(state, id, "assistant", (message) =>
    withStatus(message, {
      type: "incomplete",
      reason: "error",
      ...(error && { error }),
    })
  )
}

/**
 * Ends a Session the provider no longer holds: the run it had open fails
 * there, and a Session with none shows the failure on its latest turn.
 */
export function failSession(
  state: ProjectorState,
  error: TurnFailure
): ProjectorState {
  const ended = applyIdle(state, {}, AOS_STOP_REASONS.error, error)
  return activeAssistantId(state) === undefined
    ? failLatestTurn(ended, error)
    : ended
}

/**
 * Whether the update between the two states ended a live run in a failure
 * before it wrote a reply, so no turn of its own shows the failure. A settled
 * state the proxy restates, such as an uncertain one, ends no run.
 */
export function failedWithoutReply(
  before: ProjectorState,
  after: ProjectorState
): boolean {
  return (
    (before.execution.status === "running" ||
      before.execution.status === "waiting-for-input") &&
    after.execution !== before.execution &&
    after.execution.status === "failed" &&
    activeAssistantId(before) === undefined
  )
}

/** The blocks a turn was sent with, so a retry can re-send them verbatim. */
export function messageBlocks(
  state: ProjectorState,
  messageId: string
): ContentBlock[] {
  const message = state.messages.find((entry) => entry.id === messageId)
  return (message?.parts ?? []).flatMap((part) =>
    part.source === "message" ? [part.block] : []
  )
}

/**
 * Takes the Session's current permission requests. Each one is pinned to the
 * turn it was first seen beside, so a request no call carries stays where it
 * was asked while later turns arrive.
 */
export function applyApprovals(
  state: ProjectorState,
  approvals: readonly AcpApproval[]
): ProjectorState {
  if (approvals === state.approvals) return state
  const beside = activeAssistantId(state) ?? latestAssistantId(state.messages)
  const approvalHosts = new Map<string, string>()
  for (const { id } of approvals) {
    const host = state.approvalHosts?.get(id) ?? beside
    if (host !== undefined) approvalHosts.set(id, host)
  }
  return { ...state, approvals, approvalHosts }
}

/**
 * Each approval by the turn it reads on: the one holding the call it guards,
 * else the turn it was pinned to while that turn is still projected, else, for
 * a request still waiting, the turn it would be asked beside now. A settled one
 * with neither never moves to a turn it was not asked on.
 */
function approvalsByTurn(state: ProjectorState) {
  const byTurn = new Map<string, AcpApproval[]>()
  const has = (id: string) =>
    state.messages.some((message) => message.id === id)
  const beside = activeAssistantId(state) ?? latestAssistantId(state.messages)
  for (const approval of state.approvals ?? []) {
    const { toolCallId } = approval
    const owner =
      toolCallId === undefined
        ? undefined
        : toolCallOwner(state.messages, toolCallId)?.id
    const pinned = state.approvalHosts?.get(approval.id)
    const host = pinned !== undefined && has(pinned) ? pinned : undefined
    const turn =
      owner ?? host ?? (isSettledApproval(approval) ? undefined : beside)
    if (turn !== undefined)
      byTurn.set(turn, [...(byTurn.get(turn) ?? []), approval])
  }
  return byTurn
}

export function toThreadMessages(state: ProjectorState): ThreadMessageLike[] {
  const approvals = approvalsByTurn(state)
  return turnsOf(state.messages).map((members) => {
    const laid = members.flatMap((message) => approvals.get(message.id) ?? [])
    return toThreadMessage(turnMessage(members), laid)
  })
}
