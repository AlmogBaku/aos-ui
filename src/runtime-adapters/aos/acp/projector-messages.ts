import type {
  ContentBlock,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk/experimental/v2"
import {
  fromThreadMessageLike,
  type MessageStatus,
  type MessageTiming,
  type ThreadMessageLike,
  type ToolCallTiming,
} from "@assistant-ui/core"

import type { AosSubagent } from "@aos/protocol/acp"

import { permissionProviderMetadata } from "@/components/tool-ui/payloads/permission"
import {
  readAosToolArtifact,
  withAosToolArtifact,
  type AosDiff,
  type AosTerminal,
  type AosToolArtifact,
} from "@/components/tool-ui/tool-artifact"

import type { AcpApproval } from "./acp-approvals"
import type { ProjectedTerminal } from "./projector-terminals"

/**
 * The message half of the ACP session projector: ACP blocks kept in arrival
 * order, tagged by the update that contributed them, plus the Assistant UI
 * conversion. Keeping the original blocks lets a retry re-send a turn without
 * reconstructing it from rendered parts.
 */

type ThreadMessagePart = Exclude<ThreadMessageLike["content"], string>[number]
type ToolCallPart = Extract<ThreadMessagePart, { type: "tool-call" }>
type JsonObject = NonNullable<ToolCallPart["args"]>

export type MessageRole = "user" | "assistant"
/** Whole-message content and thoughts patch independently of each other. */
export type BlockSource = "message" | "thought"

export type ProjectedToolCall = {
  readonly toolCallId: string
  /** The programmatic name; the title stands in for a call that has none. */
  readonly name?: string
  readonly title?: string
  readonly kind?: string
  readonly status?: string
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly content?: readonly ToolCallContent[]
  readonly locations?: readonly ToolCallLocation[]
  readonly argsText?: string
  /** The call's own span in epoch ms, as the provider timed it. */
  readonly startedAt?: number
  readonly completedAt?: number
  readonly durationMs?: number
  /** The subagent this call spawned, patched by id. */
  readonly subagent?: AosSubagent
  /** The subagent's own turns, keyed by its id. */
  readonly messages?: readonly ProjectedMessage[]
  /** The terminals the call's content names, as the projector last saw them. */
  readonly terminals?: readonly ProjectedTerminal[]
  /** The tool declares an MCP App view; once seen, the call keeps it. */
  readonly app?: true
}

export type ToolCallPatch = {
  readonly toolCallId: string
  readonly name?: string | null
  readonly title?: string | null
  readonly kind?: string | null
  readonly status?: string | null
  readonly content?: readonly ToolCallContent[] | null
  readonly locations?: readonly ToolCallLocation[] | null
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

/** What `_meta.aos` adds to a call beyond its ACP fields. */
export type ToolMetaPatch = {
  readonly argsText?: string
  readonly argsTextDelta?: string
  readonly startedAt?: number
  readonly completedAt?: number
  readonly durationMs?: number
  readonly subagent?: AosSubagent
  readonly app?: true
}

export type ProjectedPart =
  | { readonly source: BlockSource; readonly block: ContentBlock }
  | { readonly source: "tool"; readonly call: ProjectedToolCall }
  | { readonly source: "data"; readonly name: string; readonly data: unknown }

/**
 * A turn's own span, in epoch ms, as the two `state_update`s bracketing its run
 * reported it. Both moments come from the wire, so a replayed turn is timed
 * exactly as the live one was.
 */
export type ProjectedTiming = {
  readonly startedAt: number
  readonly completedAt?: number
  readonly chunks: number
}

export type ProjectedMessage = {
  readonly id: string
  readonly role: MessageRole
  readonly parts: readonly ProjectedPart[]
  readonly status?: MessageStatus
  readonly timing?: ProjectedTiming
}

/** ACP three-state patch: omitted keeps, `null` clears, a value replaces. */
function patched<T>(current: T | undefined, next: T | null | undefined) {
  if (next === undefined) return current
  return next === null ? undefined : next
}

/** Upserts one message; an unseen id appends, keeping first-appearance order. */
export function withMessage(
  messages: readonly ProjectedMessage[],
  id: string,
  role: MessageRole,
  patch: (message: ProjectedMessage) => ProjectedMessage
): readonly ProjectedMessage[] {
  const current = messages.find((message) => message.id === id)
  if (!current) return [...messages, patch({ id, role, parts: [] })]
  const next = patch(current)
  return next === current
    ? messages
    : messages.map((message) => (message === current ? next : message))
}

export function latestAssistantId(messages: readonly ProjectedMessage[]) {
  return messages.findLast((message) => message.role === "assistant")?.id
}

/** The first call that matches, its subagents' calls included. */
export function findCall(
  messages: readonly ProjectedMessage[],
  matches: (call: ProjectedToolCall) => boolean
): ProjectedToolCall | undefined {
  for (const message of messages)
    for (const part of message.parts) {
      if (part.source !== "tool") continue
      if (matches(part.call)) return part.call
      const nested = findCall(part.call.messages ?? [], matches)
      if (nested) return nested
    }
  return undefined
}

const byId = (toolCallId: string) => (call: ProjectedToolCall) =>
  call.toolCallId === toolCallId

/** The turn that holds the call, at whatever depth a subagent nests it. */
export function toolCallOwner(
  messages: readonly ProjectedMessage[],
  toolCallId: string
) {
  return messages.findLast((message) => findCall([message], byId(toolCallId)))
}

/**
 * Passes every call of the turn, its subagents' calls included, through `fn`,
 * keeping the turn's identity when nothing changed.
 */
export function mapCalls(
  message: ProjectedMessage,
  fn: (call: ProjectedToolCall) => ProjectedToolCall
): ProjectedMessage {
  let changed = false
  const parts = message.parts.map((part) => {
    if (part.source !== "tool") return part
    const children = part.call.messages
    const nested = children?.map((child) => mapCalls(child, fn))
    const call =
      nested && nested.some((child, index) => child !== children![index])
        ? { ...part.call, messages: nested }
        : part.call
    const next = fn(call)
    if (next === part.call) return part
    changed = true
    return { ...part, call: next }
  })
  return changed ? { ...message, parts } : message
}

/** Upserts the subagent's own turn inside the call that spawned it. */
export function withChildMessage(
  call: ProjectedToolCall,
  subagentId: string,
  patch: (message: ProjectedMessage) => ProjectedMessage
): ProjectedToolCall {
  const messages = withMessage(
    call.messages ?? [],
    subagentId,
    "assistant",
    patch
  )
  return messages === call.messages ? call : { ...call, messages }
}

/**
 * The block a chunk extends: the message's last part when it holds text of the
 * same source. Anything else in between — a tool call, a data part, the other
 * source — leaves the open part closed behind it.
 */
function extendedBlock(
  message: ProjectedMessage,
  source: BlockSource,
  block: ContentBlock
): ContentBlock | undefined {
  const last = message.parts.at(-1)
  const delta = blockText(block)
  if (last === undefined || delta === undefined) return undefined
  if (last.source === "tool" || last.source === "data") return undefined
  if (last.source !== source) return undefined
  const text = blockText(last.block)
  return text === undefined ? undefined : { ...last.block, text: text + delta }
}

/** Appends a chunk, extending the open part of its source when there is one. */
export function appendBlock(
  message: ProjectedMessage,
  source: BlockSource,
  block: ContentBlock
): ProjectedMessage {
  const extended = extendedBlock(message, source, block)
  return {
    ...message,
    parts: extended
      ? [...message.parts.slice(0, -1), { source, block: extended }]
      : [...message.parts, { source, block }],
  }
}

/** Replaces one source's blocks in place, leaving tool calls and data parts. */
export function replaceBlocks(
  message: ProjectedMessage,
  source: BlockSource,
  blocks: readonly ContentBlock[] | null | undefined
): ProjectedMessage {
  if (blocks === undefined) return message
  const replacement = (blocks ?? []).map((block) => ({ source, block }))
  const kept = message.parts.filter((part) => part.source !== source)
  const first = message.parts.findIndex((part) => part.source === source)
  const at = first < 0 ? kept.length : first
  return {
    ...message,
    parts: [...kept.slice(0, at), ...replacement, ...kept.slice(at)],
  }
}

export function appendData(
  message: ProjectedMessage,
  name: string,
  data: unknown
): ProjectedMessage {
  return {
    ...message,
    parts: [...message.parts, { source: "data", name, data }],
  }
}

/** Replaces the data of the parts that match, in place. */
export function replaceData(
  message: ProjectedMessage,
  matches: (name: string, data: unknown) => boolean,
  data: unknown
): ProjectedMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.source === "data" && matches(part.name, part.data)
        ? { ...part, data }
        : part
    ),
  }
}

export function withStatus(
  message: ProjectedMessage,
  status: MessageStatus
): ProjectedMessage {
  return { ...message, status }
}

/** Opens a turn's span at the moment its run reported starting. */
export function startTiming(
  message: ProjectedMessage,
  startedAt: number
): ProjectedMessage {
  return { ...message, timing: { startedAt, chunks: 0 } }
}

/** Closes a timed turn's span; an untimed turn has no span to close. */
export function completeTiming(
  message: ProjectedMessage,
  completedAt: number
): ProjectedMessage {
  const { timing } = message
  return timing === undefined
    ? message
    : { ...message, timing: { ...timing, completedAt } }
}

/** One more streamed chunk of a timed turn. */
export function countChunk(message: ProjectedMessage): ProjectedMessage {
  const { timing } = message
  return timing === undefined
    ? message
    : { ...message, timing: { ...timing, chunks: timing.chunks + 1 } }
}

/** A later report restates only what changed about the same subagent. */
function mergeSubagent(
  current: AosSubagent | undefined,
  next: AosSubagent | undefined
) {
  if (next === undefined) return current
  return current?.id === next.id ? { ...current, ...next } : next
}

function mergeCall(
  current: ProjectedToolCall,
  patch: ToolCallPatch,
  meta: ToolMetaPatch
): ProjectedToolCall {
  const argsText =
    meta.argsText ??
    (meta.argsTextDelta === undefined
      ? current.argsText
      : (current.argsText ?? "") + meta.argsTextDelta)
  return {
    ...current,
    name: patched(current.name, patch.name),
    title: patched(current.title, patch.title),
    kind: patched(current.kind, patch.kind),
    status: patched(current.status, patch.status),
    content: patched(current.content, patch.content),
    locations: patched(current.locations, patch.locations),
    rawInput: patched(current.rawInput, patch.rawInput),
    rawOutput: patched(current.rawOutput, patch.rawOutput),
    argsText,
    startedAt: meta.startedAt ?? current.startedAt,
    completedAt: meta.completedAt ?? current.completedAt,
    durationMs: meta.durationMs ?? current.durationMs,
    subagent: mergeSubagent(current.subagent, meta.subagent),
    ...(current.app || meta.app ? { app: true } : {}),
  }
}

/**
 * Creates the tool call on first sight, then patches it in place, at whatever
 * depth a subagent nests it.
 */
export function patchToolCall(
  message: ProjectedMessage,
  patch: ToolCallPatch,
  meta: ToolMetaPatch
): ProjectedMessage {
  const matches = byId(patch.toolCallId)
  if (findCall([message], matches))
    return mapCalls(message, (call) =>
      matches(call) ? mergeCall(call, patch, meta) : call
    )
  const call = mergeCall({ toolCallId: patch.toolCallId }, patch, meta)
  return { ...message, parts: [...message.parts, { source: "tool", call }] }
}

export function appendToolContent(
  message: ProjectedMessage,
  toolCallId: string,
  content: ToolCallContent
): ProjectedMessage {
  return mapCalls(message, (call) =>
    call.toolCallId === toolCallId
      ? { ...call, content: [...(call.content ?? []), content] }
      : call
  )
}

/** The terminal ids the call's content names, once each. */
export function terminalIds(call: ProjectedToolCall): readonly string[] {
  const ids = (call.content ?? []).flatMap((item) =>
    item.type === "terminal" && typeof item.terminalId === "string"
      ? [item.terminalId]
      : []
  )
  return [...new Set(ids)]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The block union's open member makes any typed record a valid block. */
export function isContentBlock(value: unknown): value is ContentBlock {
  return isRecord(value) && typeof value.type === "string"
}

export function isToolCallContent(value: unknown): value is ToolCallContent {
  return isRecord(value) && typeof value.type === "string"
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value)
}

function blockText(block: ContentBlock) {
  return block.type === "text" && typeof block.text === "string"
    ? block.text
    : undefined
}

/** Text, inline images, and references; anything else has no faithful part. */
function blockPart(block: ContentBlock): ThreadMessagePart[] {
  const text = blockText(block)
  if (text !== undefined) return [{ type: "text", text }]
  if (
    block.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  )
    return [
      { type: "image", image: `data:${block.mimeType};base64,${block.data}` },
    ]
  if (block.type === "resource_link" && typeof block.uri === "string")
    return [
      {
        type: "file",
        data: block.uri,
        mimeType:
          typeof block.mimeType === "string"
            ? block.mimeType
            : "application/octet-stream",
        ...(typeof block.name === "string" ? { filename: block.name } : {}),
      },
    ]
  return []
}

/** Streamed tool content stands in for a result the provider never summarized. */
function contentResult(content: readonly ToolCallContent[] | undefined) {
  if (!content || content.length === 0) return undefined
  const text = content.flatMap((item) =>
    item.type === "content" && isContentBlock(item.content)
      ? [blockText(item.content) ?? ""]
      : []
  )
  return text.length > 0 ? text.join("") : undefined
}

const DIFF_OPERATIONS = new Set(["add", "delete", "modify", "move", "copy"])

/** An ACP diff as the tool UI draws it; unreadable changes are dropped. */
function diffOf(item: ToolCallContent): AosDiff[] {
  if (item.type !== "diff" || !Array.isArray(item.changes)) return []
  const changes = item.changes.flatMap((change: unknown) =>
    isRecord(change) &&
    typeof change.operation === "string" &&
    DIFF_OPERATIONS.has(change.operation) &&
    typeof change.path === "string"
      ? [
          {
            kind: change.operation as AosDiff["changes"][number]["kind"],
            path: change.path,
            ...(typeof change.oldPath === "string"
              ? { oldPath: change.oldPath }
              : {}),
          },
        ]
      : []
  )
  const patch =
    isRecord(item.patch) && typeof item.patch.text === "string"
      ? item.patch.text
      : undefined
  return changes.length === 0
    ? []
    : [{ changes, ...(patch === undefined ? {} : { patch }) }]
}

function terminalOf(
  { exited, exitCode, signal, ...terminal }: ProjectedTerminal,
  settled: boolean
): AosTerminal {
  return {
    ...terminal,
    running: !exited && !settled,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
  }
}

/** Only a kind the tool UI knows travels; an unknown one reads as none. */
const knownKind = (kind: string | undefined) =>
  kind === undefined ? undefined : readAosToolArtifact({ aos: { kind } })?.kind

/** What the call carries beyond args and result, or nothing at all. */
function toolArtifact(
  call: ProjectedToolCall,
  result: unknown,
  turn: MessageStatus | undefined
): AosToolArtifact | undefined {
  const kind = knownKind(call.kind)
  const locations = (call.locations ?? []).map(({ path, line }) =>
    typeof line === "number" ? { path, line } : { path }
  )
  const diffs = (call.content ?? []).flatMap(diffOf)
  const settled = call.status === "completed" || call.status === "failed"
  const terminals = (call.terminals ?? []).map((terminal) =>
    terminalOf(terminal, settled)
  )
  const artifact: AosToolArtifact = {
    ...(kind === undefined ? {} : { kind }),
    ...(locations.length === 0 ? {} : { locations }),
    ...(diffs.length === 0 ? {} : { diffs }),
    ...(terminals.length === 0 ? {} : { terminals }),
    ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
    ...(call.app ? { app: appState(call, result, turn) } : {}),
  }
  return Object.keys(artifact).length === 0 ? undefined : artifact
}

/**
 * The call's span from whichever of its start, end, and duration the provider
 * reported. A duration alone (Hermes reports neither end) spans from epoch
 * zero, since only the span is ever read; a call with no start and no
 * duration is untimed.
 */
function toolTiming(call: ProjectedToolCall): ToolCallTiming | undefined {
  const { startedAt, completedAt, durationMs } = call
  if (startedAt === undefined) {
    if (durationMs === undefined) return undefined
    const end = completedAt ?? durationMs
    return { startedAt: end - durationMs, completedAt: end }
  }
  const end =
    completedAt ??
    (durationMs === undefined ? undefined : startedAt + durationMs)
  return end === undefined ? { startedAt } : { startedAt, completedAt: end }
}

/** A subagent's turn, as the nested thread message the call part carries. */
function childMessage(message: ProjectedMessage, call: ProjectedToolCall) {
  const status: MessageStatus =
    call.status === "failed"
      ? { type: "incomplete", reason: "error" }
      : call.status === "completed"
        ? { type: "complete", reason: "stop" }
        : { type: "running" }
  return fromThreadMessageLike(toThreadMessage(message), message.id, status)
}

/** Why an App call cannot produce a result anymore, if it cannot. */
function appCancellation(
  call: ProjectedToolCall,
  result: unknown,
  turn: MessageStatus | undefined
) {
  if (result !== undefined || call.status === "completed") return undefined
  if (call.status === "failed") return "The tool call failed"
  return turn?.type === "complete" || turn?.type === "incomplete"
    ? "The turn ended before the tool call finished"
    : undefined
}

/** How far an App call has come: its input, its settlement, or why it ended. */
function appState(
  call: ProjectedToolCall,
  result: unknown,
  turn: MessageStatus | undefined
) {
  const cancelled = appCancellation(call, result, turn)
  return {
    ...(call.rawInput === undefined ? {} : { input: true as const }),
    ...(call.status === "completed" ? { settled: true as const } : {}),
    ...(cancelled === undefined ? {} : { cancelled }),
  }
}

/**
 * The approval as Assistant UI reads it, asking with the explanation when the
 * provider gives one; the operation itself rides in the part's metadata.
 */
function approvalOf({
  id,
  action,
  description,
  options,
  optionId,
  approved,
  resolution,
}: AcpApproval): NonNullable<ToolCallPart["approval"]> {
  return {
    id,
    prompt: description ?? action,
    options,
    ...(optionId === undefined ? {} : { optionId }),
    ...(approved === undefined ? {} : { approved }),
    ...(resolution === undefined ? {} : { resolution }),
  }
}

function toolPart(
  call: ProjectedToolCall,
  turn: MessageStatus | undefined,
  approval?: AcpApproval
): ThreadMessagePart {
  const result = call.rawOutput ?? contentResult(call.content)
  const artifact = toolArtifact(call, result, turn)
  const timing = toolTiming(call)
  const messages = call.messages ?? []
  return {
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.name ?? call.title ?? call.toolCallId,
    args: isJsonObject(call.rawInput) ? call.rawInput : {},
    ...(call.argsText === undefined ? {} : { argsText: call.argsText }),
    ...(result === undefined ? {} : { result }),
    isError: call.status === "failed",
    ...(artifact === undefined
      ? {}
      : { artifact: withAosToolArtifact(undefined, artifact) }),
    ...(timing === undefined ? {} : { timing }),
    ...(messages.length === 0
      ? {}
      : { messages: messages.map((message) => childMessage(message, call)) }),
    ...(approval === undefined
      ? {}
      : {
          approval: approvalOf(approval),
          providerMetadata: permissionProviderMetadata(approval.action),
        }),
  }
}

const STANDALONE_APPROVAL_PREFIX = "aos-permission-"

/**
 * A permission no call of the turn carries reads as the `request_permission`
 * tool the permission card renders, so it is still answered in the transcript.
 */
function standaloneApprovalPart(
  approval: AcpApproval,
  turn: MessageStatus | undefined
): ThreadMessagePart {
  const call: ProjectedToolCall = {
    toolCallId: `${STANDALONE_APPROVAL_PREFIX}${approval.id}`,
    name: "request_permission",
    rawInput: { action: approval.action },
  }
  return toolPart(call, turn, approval)
}

const isSettled = (call: ProjectedToolCall) =>
  call.status === "completed" || call.status === "failed"

function threadPart(
  part: ProjectedPart,
  turn: MessageStatus | undefined,
  approvals: readonly AcpApproval[] = []
): ThreadMessagePart[] {
  if (part.source === "data")
    return [{ type: "data", name: part.name, data: part.data }]
  if (part.source === "tool") {
    // A settled call shows its own outcome, so its approval has done its job.
    const approval = isSettled(part.call)
      ? undefined
      : approvals.find(({ toolCallId }) => toolCallId === part.call.toolCallId)
    return [toolPart(part.call, turn, approval)]
  }
  if (part.source === "thought") {
    const text = blockText(part.block)
    return text === undefined ? [] : [{ type: "reasoning", text }]
  }
  return blockPart(part.block)
}

/**
 * The turn's span and shape, as Assistant UI's own message timing. The total is
 * the difference between the two moments the wire reported, so nothing on the
 * way to the UI consults a clock.
 */
function timingMetadata(message: ProjectedMessage): MessageTiming | undefined {
  const { timing } = message
  if (timing === undefined) return undefined
  return {
    streamStartTime: timing.startedAt,
    ...(timing.completedAt === undefined
      ? {}
      : { totalStreamTime: timing.completedAt - timing.startedAt }),
    totalChunks: timing.chunks,
    toolCallCount: message.parts.filter((part) => part.source === "tool")
      .length,
  }
}

function convert(
  message: ProjectedMessage,
  approvals: readonly AcpApproval[]
): ThreadMessageLike {
  const timing = timingMetadata(message)
  const guarded = new Set(
    message.parts.flatMap((part) =>
      part.source === "tool" ? [part.call.toolCallId] : []
    )
  )
  const standalone = approvals.filter(
    ({ toolCallId }) => toolCallId === undefined || !guarded.has(toolCallId)
  )
  return {
    id: message.id,
    role: message.role,
    content: [
      ...message.parts.flatMap((part) =>
        threadPart(part, message.status, approvals)
      ),
      ...standalone.map((approval) =>
        standaloneApprovalPart(approval, message.status)
      ),
    ],
    ...(message.status === undefined ? {} : { status: message.status }),
    ...(timing === undefined ? {} : { metadata: { timing } }),
  }
}

const converted = new WeakMap<ProjectedMessage, ThreadMessageLike>()
const overlaid = new WeakMap<
  ProjectedMessage,
  { approvals: readonly AcpApproval[]; value: ThreadMessageLike }
>()

const sameItems = <T>(left: readonly T[], right: readonly T[]) =>
  left.length === right.length &&
  left.every((item, index) => item === right[index])

/**
 * Memoized by message reference, and by the approvals laid over it, so an
 * unchanged turn keeps its identity. `approvals` are the turn's own: those on
 * one of its calls and those it hosts on their own.
 */
export function toThreadMessage(
  message: ProjectedMessage,
  approvals: readonly AcpApproval[] = []
): ThreadMessageLike {
  if (approvals.length === 0) {
    const cached = converted.get(message)
    if (cached) return cached
    const value = convert(message, approvals)
    converted.set(message, value)
    return value
  }
  const cached = overlaid.get(message)
  if (cached && sameItems(cached.approvals, approvals)) return cached.value
  const value = convert(message, approvals)
  overlaid.set(message, { approvals, value })
  return value
}
