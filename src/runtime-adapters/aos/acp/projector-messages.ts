import type {
  ContentBlock,
  ToolCallContent,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { MessageStatus, ThreadMessageLike } from "@assistant-ui/core"

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
  readonly title?: string
  readonly status?: string
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly content?: readonly ToolCallContent[]
  readonly argsText?: string
}

export type ToolCallPatch = {
  readonly toolCallId: string
  readonly title?: string | null
  readonly status?: string | null
  readonly content?: readonly ToolCallContent[] | null
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

export type ToolArgsPatch = {
  readonly argsText?: string
  readonly argsTextDelta?: string
}

export type ProjectedPart =
  | { readonly source: BlockSource; readonly block: ContentBlock }
  | { readonly source: "tool"; readonly call: ProjectedToolCall }
  | { readonly source: "data"; readonly name: string; readonly data: unknown }

export type ProjectedMessage = {
  readonly id: string
  readonly role: MessageRole
  readonly parts: readonly ProjectedPart[]
  readonly status?: MessageStatus
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

export function toolCallOwner(
  messages: readonly ProjectedMessage[],
  toolCallId: string
) {
  return messages.findLast((message) =>
    message.parts.some(
      (part) => part.source === "tool" && part.call.toolCallId === toolCallId
    )
  )
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

export function withStatus(
  message: ProjectedMessage,
  status: MessageStatus
): ProjectedMessage {
  return { ...message, status }
}

function mergeCall(
  current: ProjectedToolCall,
  patch: ToolCallPatch,
  args: ToolArgsPatch
): ProjectedToolCall {
  const argsText =
    args.argsText ??
    (args.argsTextDelta === undefined
      ? current.argsText
      : (current.argsText ?? "") + args.argsTextDelta)
  return {
    toolCallId: current.toolCallId,
    title: patched(current.title, patch.title),
    status: patched(current.status, patch.status),
    content: patched(current.content, patch.content),
    rawInput: patched(current.rawInput, patch.rawInput),
    rawOutput: patched(current.rawOutput, patch.rawOutput),
    argsText,
  }
}

/** Creates the tool call on first sight, then patches it in place. */
export function patchToolCall(
  message: ProjectedMessage,
  patch: ToolCallPatch,
  args: ToolArgsPatch
): ProjectedMessage {
  let replaced = false
  const parts = message.parts.map((part) => {
    if (part.source !== "tool" || part.call.toolCallId !== patch.toolCallId)
      return part
    replaced = true
    return { ...part, call: mergeCall(part.call, patch, args) }
  })
  if (replaced) return { ...message, parts }
  const call = mergeCall({ toolCallId: patch.toolCallId }, patch, args)
  return { ...message, parts: [...message.parts, { source: "tool", call }] }
}

export function appendToolContent(
  message: ProjectedMessage,
  toolCallId: string,
  content: ToolCallContent
): ProjectedMessage {
  const parts = message.parts.map((part) =>
    part.source === "tool" && part.call.toolCallId === toolCallId
      ? {
          ...part,
          call: {
            ...part.call,
            content: [...(part.call.content ?? []), content],
          },
        }
      : part
  )
  return { ...message, parts }
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

function toolPart(call: ProjectedToolCall): ThreadMessagePart {
  const result = call.rawOutput ?? contentResult(call.content)
  return {
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.title ?? call.toolCallId,
    args: isJsonObject(call.rawInput) ? call.rawInput : {},
    ...(call.argsText === undefined ? {} : { argsText: call.argsText }),
    ...(result === undefined ? {} : { result }),
    isError: call.status === "failed",
  }
}

function threadPart(part: ProjectedPart): ThreadMessagePart[] {
  if (part.source === "data")
    return [{ type: "data", name: part.name, data: part.data }]
  if (part.source === "tool") return [toolPart(part.call)]
  if (part.source === "thought") {
    const text = blockText(part.block)
    return text === undefined ? [] : [{ type: "reasoning", text }]
  }
  return blockPart(part.block)
}

const converted = new WeakMap<ProjectedMessage, ThreadMessageLike>()

/** Memoized by message reference so an unchanged turn keeps its identity. */
export function toThreadMessage(message: ProjectedMessage): ThreadMessageLike {
  const cached = converted.get(message)
  if (cached) return cached
  const value: ThreadMessageLike = {
    id: message.id,
    role: message.role,
    content: message.parts.flatMap(threadPart),
    ...(message.status === undefined ? {} : { status: message.status }),
  }
  converted.set(message, value)
  return value
}
