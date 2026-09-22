import type { SessionMessage } from "../../../protocol"
import {
  isRecord as isNativeRecord,
  rowText,
  timestamp,
  timestampMs,
  trimmedText,
  utf8BytesWithin,
} from "./native"
import {
  projectHermesAttachedImages,
  projectHermesMediaText,
} from "./media-artifacts"
import {
  canonicalToolName,
  projectHermesToolCall,
  projectHermesToolOutcome,
} from "./tool-data"

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonRecord = Record<string, JsonValue>
function isRecord(value: unknown): value is JsonRecord {
  return isNativeRecord(value)
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const values = value.map(jsonValue)
    return values.some((item) => item === undefined)
      ? undefined
      : (values as JsonValue[])
  }
  if (!isRecord(value)) return undefined
  const output: JsonRecord = {}
  for (const [key, item] of Object.entries(value)) {
    const projected = jsonValue(item)
    if (projected === undefined) return undefined
    output[key] = projected
  }
  return output
}

/**
 * Row content parser: unlike `native.parseJson` this projects the decoded value
 * into the strict `JsonValue` the public history shape accepts, and keeps the
 * raw string when a row's content is not JSON at all.
 */
function parseRowJson(value: unknown): JsonValue | undefined {
  if (typeof value !== "string") return jsonValue(value)
  try {
    return jsonValue(JSON.parse(value) as unknown)
  } catch {
    return value
  }
}

function imageSource(value: unknown) {
  const image = isRecord(value) ? value.url : value
  if (typeof image !== "string") return undefined
  return /^(?:data:image\/(?:png|jpeg|gif|webp|bmp);base64,|\/api\/aos\/v1\/)/u.test(
    image
  )
    ? image
    : undefined
}

const HERMES_CONTEXT_MARKER =
  /(?:^|\n)--- (?:Attached Context|Context Warnings) ---[^\n]*(?:\n|$)/u
const HERMES_FILE_REFERENCE =
  /^@file:(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))$/u
const SAFE_MIME =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u

function safeAttachmentName(reference: string) {
  const path = reference.match(HERMES_FILE_REFERENCE)?.slice(1).find(Boolean)
  const name = path?.split(/[\\/]/u).at(-1)
  const hasControlCharacter = [...(name ?? "")].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  return name &&
    utf8BytesWithin(name, 255) !== undefined &&
    !hasControlCharacter &&
    name !== "." &&
    name !== ".."
    ? name
    : undefined
}

function attachmentMime(context: string, reference: string) {
  const line = context
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes(reference))
  const mime = line
    ?.slice(line.indexOf(reference) + reference.length)
    .match(/^\s+\(([^,\s()]+),/u)?.[1]
  return mime && SAFE_MIME.test(mime) ? mime : undefined
}

function projectHermesFileReferences(text: string, messageId: string) {
  const marker = text.match(HERMES_CONTEXT_MARKER)
  if (!marker || marker.index === undefined) return { text }
  const context = text.slice(marker.index)
  const lines = text.slice(0, marker.index).trimEnd().split(/\r?\n/u)
  const references: string[] = []
  while (lines.length > 0) {
    const candidate = lines.at(-1)?.trim() ?? ""
    if (!HERMES_FILE_REFERENCE.test(candidate)) break
    references.unshift(candidate)
    lines.pop()
  }
  const attachments = references.flatMap((reference, index) => {
    const name = safeAttachmentName(reference)
    if (!name) return []
    const contentType = attachmentMime(context, reference)
    return [
      {
        id: `${messageId}:attachment:${index}`,
        type: "file" as const,
        name,
        ...(contentType ? { contentType } : {}),
        status: { type: "complete" as const },
        content: [],
      },
    ]
  })
  return { text: lines.join("\n").trim(), attachments }
}

/**
 * What a durable user row shows: the prose the operator wrote, the files they
 * referenced, and the images they attached. Hermes persists both kinds as
 * directive text, so neither survives as prose — an attached image becomes the
 * same opaque artifact part a published one travels as.
 */
function projectHermesUserContent(text: string, messageId: string) {
  const attached = projectHermesAttachedImages(text)
  return {
    ...projectHermesFileReferences(attached.text, messageId),
    artifacts: attached.artifacts.map(({ descriptor }) => ({
      type: "data" as const,
      name: "aos.artifact",
      data: descriptor,
    })),
  }
}

/**
 * The scaffold Hermes prepends to the `api_content` of the user row an accepted
 * `session.redirect` persists: `agent/conversation_loop.py`
 * `_apply_active_turn_redirect` writes it there while the interrupted turn is
 * still open, so the row is the correction itself rather than a new prompt. See
 * the pinned upstream commit in `UPSTREAM.md`.
 */
const REDIRECT_SCAFFOLD_PREFIX =
  "[Context from the interrupted assistant response]"

/** A mid-turn correction, which the run journal also acknowledges. */
function isRedirectCorrection(value: JsonRecord): boolean {
  const apiContent = value.api_content
  return (
    typeof apiContent === "string" &&
    apiContent.startsWith(REDIRECT_SCAFFOLD_PREFIX)
  )
}

/** Converts provider-native durable rows into the strict public history shape. */
export function projectHermesHistory(
  rows: readonly unknown[]
): SessionMessage[] {
  const messages: SessionMessage[] = []
  const calls = new Map<string, { messageIndex: number; partIndex: number }>()
  const mediaReferences = new Map<number, Set<string>>()
  /** The newest row time each merged turn was built from, in epoch ms. */
  const completions = new Map<number, number>()

  /** One turn spans every row that patched into it, so its end is their newest. */
  function contributed(messageIndex: number, row: JsonRecord) {
    const ms = timestampMs(row.timestamp ?? row.created_at)
    if (ms === undefined) return
    const newest = completions.get(messageIndex)
    if (newest === undefined || ms > newest) completions.set(messageIndex, ms)
  }

  /** Keeps every open call of one turn addressing its part after an insertion. */
  function shifted(messageIndex: number, afterPartIndex: number, by: number) {
    for (const [id, call] of calls)
      if (call.messageIndex === messageIndex && call.partIndex > afterPartIndex)
        calls.set(id, { ...call, partIndex: call.partIndex + by })
  }

  rows.forEach((value, index) => {
    if (!isRecord(value) || trimmedText(value.display_kind)) return
    const role = trimmedText(value.role)
    if (role === "tool") {
      const toolCallId = trimmedText(value.tool_call_id ?? value.toolCallId)
      const target = toolCallId ? calls.get(toolCallId) : undefined
      if (!toolCallId || !target) return
      const message = messages[target.messageIndex]
      const part = message?.content[target.partIndex]
      if (
        !message ||
        message.role !== "assistant" ||
        part?.type !== "tool-call"
      )
        return
      const resultToolName = trimmedText(value.tool_name ?? value.toolName)
      const toolName = resultToolName
        ? canonicalToolName(resultToolName)
        : part.toolName
      const outcome = projectHermesToolOutcome(
        toolCallId,
        toolName,
        value.content ?? value.result,
        value.is_error === true
      )
      const content = [...message.content]
      content[target.partIndex] = {
        ...part,
        ...(resultToolName ? { toolName } : {}),
        result: outcome.result,
        ...(outcome.isError ? { isError: true } : {}),
      }
      // Live publishes an artifact the moment its tool result lands, so the
      // stored turn places it there too rather than at the turn's end.
      if (outcome.parts.length > 0) {
        content.splice(target.partIndex + 1, 0, ...outcome.parts)
        shifted(target.messageIndex, target.partIndex, outcome.parts.length)
      }
      if (outcome.trustedMedia.length) {
        const trusted = mediaReferences.get(target.messageIndex) ?? new Set()
        for (const reference of outcome.trustedMedia) trusted.add(reference)
        mediaReferences.set(target.messageIndex, trusted)
      }
      messages[target.messageIndex] = { ...message, content }
      contributed(target.messageIndex, value)
      return
    }

    if (role !== "user" && role !== "assistant" && role !== "system") return
    const rowId = value.row_id ?? value._row_id
    const id =
      typeof rowId === "number" && Number.isSafeInteger(rowId) && rowId > 0
        ? `hermes-row-${rowId}`
        : typeof value.id === "number" &&
            Number.isSafeInteger(value.id) &&
            value.id > 0
          ? `hermes-row-${value.id}`
          : (trimmedText(value.id) ?? `hermes-history-${index}`)
    const previousAssistant =
      role === "assistant" && messages.at(-1)?.role === "assistant"
        ? messages.at(-1)
        : undefined
    const messageIndex = previousAssistant
      ? messages.length - 1
      : messages.length
    const rawContent = parseRowJson(value.content)
    // `rowText` only reads Hermes' display projection on a persisted compaction
    // carrier, so provider-only fields cannot replace a Session's durable
    // transcript content. The artifact reader derives a row's text the same way,
    // so an attachment it resolves is the one the operator was shown.
    const text = rowText(value, rawContent)
    const userContent =
      role === "user" ? projectHermesUserContent(text, id) : undefined
    const visibleText =
      role === "assistant"
        ? projectHermesMediaText(text, mediaReferences.get(messageIndex) ?? [])
        : (userContent?.text ?? text)
    const content = previousAssistant ? [...previousAssistant.content] : []
    const reasoning =
      role === "assistant"
        ? (trimmedText(value.reasoning_content) ?? trimmedText(value.reasoning))
        : undefined
    if (reasoning) content.push({ type: "reasoning", text: reasoning })
    if (visibleText) content.push({ type: "text", text: visibleText })
    const inlineImages =
      role === "user" && Array.isArray(rawContent)
        ? rawContent.flatMap((part) => {
            const image =
              isRecord(part) && part.type === "image_url"
                ? imageSource(part.image_url)
                : undefined
            return image ? [{ type: "image" as const, image }] : []
          })
        : []
    for (const image of inlineImages) content.push(image)
    // A row that inlines its image already shows those bytes; the directive it
    // also persisted would only repeat them.
    if (inlineImages.length === 0)
      for (const artifact of userContent?.artifacts ?? [])
        content.push(artifact)
    if (role === "assistant" && Array.isArray(value.tool_calls)) {
      for (const rawCall of value.tool_calls) {
        if (!isRecord(rawCall)) continue
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined
        const toolCallId = trimmedText(rawCall.id)
        const nativeToolName = fn && trimmedText(fn.name)
        if (!toolCallId || !nativeToolName) continue
        const { toolName, args } = projectHermesToolCall(
          nativeToolName,
          fn?.arguments
        )
        const partIndex = content.length
        content.push({
          type: "tool-call",
          toolCallId,
          toolName,
          args,
          argsText: JSON.stringify(args),
        })
        calls.set(toolCallId, { messageIndex, partIndex })
      }
    }
    // Only an assistant turn spans more than one row, so only its end is worth
    // recording: every other role completed where it was created.
    if (role === "assistant") contributed(messageIndex, value)
    if (previousAssistant) {
      messages[messageIndex] = { ...previousAssistant, content }
    } else {
      messages.push({
        id,
        role,
        content,
        createdAt: timestamp(value.timestamp ?? value.created_at, index),
        ...(userContent?.attachments?.length
          ? { attachments: userContent.attachments }
          : {}),
        // The same turn the journal acknowledges as `aos.steer.accepted`: the
        // flag lets a from-start replay announce it once.
        ...(role === "user" && isRedirectCorrection(value)
          ? { metadata: { custom: { correction: true } } }
          : {}),
      })
    }
  })
  // Stamped last because the rows that finish an assistant turn arrive after the
  // row that opened it.
  return messages.map((message, index) => {
    const ms = completions.get(index)
    return ms === undefined
      ? message
      : { ...message, completedAt: new Date(ms).toISOString() }
  })
}
