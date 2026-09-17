import type { SessionMessage } from "../../../protocol"
import { isRecord as isNativeRecord, timestamp } from "./native"
import {
  containsPrivateValue,
  projectHermesArtifactReceipt,
  projectHermesMediaArtifacts,
  projectHermesMediaText,
} from "./media-artifacts"
import {
  canonicalToolName,
  hermesToolResultIsError,
  projectHermesToolArgs,
  projectHermesToolResult,
} from "./tool-data"

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonRecord = Record<string, JsonValue>

const MAX_PUBLIC_DEPTH = 8
const MAX_PUBLIC_ENTRIES = 100
const MAX_PUBLIC_STRING_LENGTH = 4_000

const privateToolKeys = new Set([
  "apikey",
  "authorization",
  "baseurl",
  "canonicalsession",
  "cookie",
  "credential",
  "credentials",
  "cwd",
  "directory",
  "endpoint",
  "file",
  "filepath",
  "files",
  "filepaths",
  "href",
  "livesessionid",
  "meta",
  "metadata",
  "nativeposition",
  "nativemetadata",
  "password",
  "passwd",
  "path",
  "paths",
  "position",
  "privatemetadata",
  "privatekey",
  "providermetadata",
  "providerurl",
  "reference",
  "root",
  "secret",
  "sessionid",
  "setcookie",
  "source",
  "storedsessionid",
  "token",
  "uri",
  "url",
  "websocketurl",
  "workdir",
  "workingdirectory",
])

function isRecord(value: unknown): value is JsonRecord {
  return isNativeRecord(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
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

function parseJson(value: unknown): JsonValue | undefined {
  if (typeof value !== "string") return jsonValue(value)
  try {
    return jsonValue(JSON.parse(value) as unknown)
  } catch {
    return value
  }
}

function jsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function normalizedKey(key: string) {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase()
}

function isPrivateToolKey(key: string) {
  const normalized = normalizedKey(key)
  return (
    privateToolKeys.has(normalized) ||
    [
      "credential",
      "credentials",
      "metadata",
      "password",
      "path",
      "position",
      "secret",
      "sessionid",
      "token",
      "uri",
      "url",
    ].some((suffix) => normalized.endsWith(suffix))
  )
}

function publicJsonValue(value: JsonValue, depth = 0): JsonValue | undefined {
  if (depth > MAX_PUBLIC_DEPTH) return undefined
  if (typeof value === "string") {
    if (value.length > MAX_PUBLIC_STRING_LENGTH || containsPrivateValue(value))
      return undefined
    return value
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value
  if (Array.isArray(value))
    return value.slice(0, MAX_PUBLIC_ENTRIES).flatMap((item) => {
      const projected = publicJsonValue(item, depth + 1)
      return projected === undefined ? [] : [projected]
    })
  const result: JsonRecord = {}
  for (const [key, item] of Object.entries(value).slice(
    0,
    MAX_PUBLIC_ENTRIES
  )) {
    if (isPrivateToolKey(key)) continue
    const projected = publicJsonValue(item, depth + 1)
    if (projected !== undefined) result[key] = projected
  }
  return result
}

function publicToolArgs(name: string, args: JsonRecord): JsonRecord {
  const projected = projectHermesToolArgs(args)
  if (canonicalToolName(name) !== "present_artifact") return projected
  const artifactArgs: JsonRecord = {}
  for (const key of ["id", "title", "filename", "mimeType", "sizeBytes"])
    if (key in projected) artifactArgs[key] = projected[key]!
  return artifactArgs
}

function publicToolResult(name: string, value: unknown, isError: boolean) {
  const canonicalName = canonicalToolName(name)
  if (canonicalName === "text_to_speech")
    return { status: isError ? "failed" : "completed" }
  if (canonicalName === "question") {
    const responses = projectQuestionResponses(value)
    if (responses) return responses
  }
  const projected = projectHermesToolResult(value, isError)
  if (
    canonicalName !== "present_artifact" ||
    !projected ||
    typeof projected !== "object" ||
    Array.isArray(projected)
  )
    return projected
  const receipt: JsonRecord = {}
  for (const key of ["ok", "status", "message"])
    if (key in projected) receipt[key] = projected[key]!
  return Object.keys(receipt).length
    ? receipt
    : { status: isError ? "failed" : "completed" }
}

function canonicalToolArgs(name: string, args: JsonRecord) {
  if (name === "clarify") {
    if (Array.isArray(args.questions)) {
      const questions = args.questions.flatMap((candidate) => {
        if (!isRecord(candidate)) return []
        const question = stringValue(candidate.question)
        if (!question) return []
        const options = Array.isArray(candidate.choices)
          ? candidate.choices.filter(
              (choice): choice is string =>
                typeof choice === "string" && choice.trim().length > 0
            )
          : []
        return [
          {
            question,
            ...(options.length ? { options } : {}),
            allowFreeform: options.length === 0,
            multiple: candidate.multi_select === true,
          } satisfies JsonRecord,
        ]
      })
      if (questions.length)
        return {
          question: `${questions.length} ${questions.length === 1 ? "question" : "questions"}`,
          questions,
          // This keeps the existing question renderer valid while its
          // settled receipt reads the richer batched shape below.
          allowFreeform: true,
        }
    }
    const { choices, multi_select, allow_freeform, ...rest } = args
    const options = Array.isArray(choices)
      ? choices.filter(
          (choice): choice is string =>
            typeof choice === "string" && choice.trim().length > 0
        )
      : []
    return {
      ...rest,
      ...(options.length ? { options } : {}),
      allowFreeform:
        typeof allow_freeform === "boolean"
          ? allow_freeform
          : options.length === 0,
      multiple: multi_select === true,
    }
  }
  if (canonicalToolName(name) !== "delegate_subagent") return args
  if (typeof args.description === "string" && args.description.trim())
    return args
  const candidate = [
    args.goal,
    args.goals,
    args.prompt,
    args.task,
    args.name,
    args.skill,
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .find((value) => typeof value === "string" && value.trim())
  return typeof candidate === "string"
    ? { ...args, description: candidate.trim() }
    : args
}

function projectQuestionResponses(value: unknown): JsonRecord | undefined {
  const parsed = parseJson(value)
  if (!isRecord(parsed) || !Array.isArray(parsed.responses)) return undefined
  const responses = parsed.responses.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const question = stringValue(candidate.question)
    const rawResponse = candidate.user_response
    if (!question || typeof rawResponse !== "string") return []
    let answers: string[] = []
    if (rawResponse) {
      try {
        const decoded: unknown = JSON.parse(rawResponse)
        answers = Array.isArray(decoded)
          ? decoded.filter((answer): answer is string => {
              const safe = publicJsonValue(answer)
              return typeof safe === "string" && safe.length > 0
            })
          : [rawResponse]
      } catch {
        answers = [rawResponse]
      }
    }
    answers = answers.flatMap((answer) => {
      const safe = publicJsonValue(answer)
      return typeof safe === "string" && safe.length > 0 ? [safe] : []
    })
    return [{ question, answers } satisfies JsonRecord]
  })
  if (!responses.length) return undefined
  return {
    status: responses.some(({ answers }) => (answers as JsonValue[]).length)
      ? "answered"
      : "cancelled",
    responses,
  }
}

export function projectHermesQuestionArgs(value: unknown) {
  const parsed = parseJson(value)
  if (!isRecord(parsed)) return undefined
  const normalized =
    Array.isArray(parsed.questions) || "choices" in parsed
      ? canonicalToolArgs("clarify", parsed)
      : parsed
  return publicToolArgs("question", normalized)
}

export function projectHermesQuestionResult(value: unknown) {
  return projectQuestionResponses(value)
}

function unwrapTool(name: string, args: JsonRecord) {
  if (name !== "tool_call") return { name, args }
  const selectedName = stringValue(args.name)
  const selectedArgs = parseJson(args.arguments)
  if (!selectedName || !isRecord(selectedArgs)) return { name, args }
  return { name: selectedName, args: selectedArgs }
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
    Buffer.byteLength(name, "utf8") <= 255 &&
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

function projectHermesUserContent(text: string, messageId: string) {
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

/** Converts provider-native durable rows into the strict public history shape. */
export function projectHermesHistory(
  rows: readonly unknown[]
): SessionMessage[] {
  const messages: SessionMessage[] = []
  const calls = new Map<string, { messageIndex: number; partIndex: number }>()
  const mediaReferences = new Map<number, Set<string>>()

  rows.forEach((value, index) => {
    if (!isRecord(value) || stringValue(value.display_kind)) return
    const role = stringValue(value.role)
    if (role === "tool") {
      const toolCallId = stringValue(value.tool_call_id ?? value.toolCallId)
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
      const resultToolName = stringValue(value.tool_name ?? value.toolName)
      const toolName = resultToolName
        ? canonicalToolName(resultToolName)
        : part.toolName
      const toolResult = value.content ?? value.result
      const isError = hermesToolResultIsError(
        toolResult,
        value.is_error === true
      )
      const artifact =
        toolName === "present_artifact" && !isError
          ? projectHermesArtifactReceipt(toolResult)
          : undefined
      const mediaArtifacts = !isError
        ? projectHermesMediaArtifacts(toolCallId, toolName, toolResult)
        : []
      const content = [...message.content]
      content[target.partIndex] = {
        ...part,
        ...(resultToolName ? { toolName } : {}),
        result:
          artifact?.result ?? publicToolResult(toolName, toolResult, isError),
        ...(isError ? { isError: true } : {}),
      }
      if (artifact) content.push(artifact.part)
      if (mediaArtifacts.length) {
        const trusted = mediaReferences.get(target.messageIndex) ?? new Set()
        for (const media of mediaArtifacts) {
          trusted.add(media.reference)
          content.push({
            type: "data",
            name: "aos.artifact",
            data: media.descriptor,
          })
        }
        mediaReferences.set(target.messageIndex, trusted)
      }
      messages[target.messageIndex] = { ...message, content }
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
          : (stringValue(value.id) ?? `hermes-history-${index}`)
    const previousAssistant =
      role === "assistant" && messages.at(-1)?.role === "assistant"
        ? messages.at(-1)
        : undefined
    const messageIndex = previousAssistant
      ? messages.length - 1
      : messages.length
    const rawContent = parseJson(value.content)
    // Hermes only attaches a display projection while rendering a persisted
    // compaction carrier. Ignore it on ordinary rows so provider-only fields
    // cannot replace a Session's durable transcript content.
    const displayContent =
      value._compressed_summary === true ? value.display_content : undefined
    const text = String(
      displayContent ??
        value.text ??
        (Array.isArray(rawContent)
          ? rawContent
              .filter((part) => isRecord(part) && part.type === "text")
              .flatMap((part) =>
                isRecord(part) &&
                part.type === "text" &&
                typeof part.text === "string"
                  ? [part.text]
                  : []
              )
              .join("\n")
          : rawContent) ??
        ""
    )
    const userContent =
      role === "user" ? projectHermesUserContent(text, id) : undefined
    const visibleText =
      role === "assistant"
        ? projectHermesMediaText(text, mediaReferences.get(messageIndex) ?? [])
        : (userContent?.text ?? text)
    const content = previousAssistant ? [...previousAssistant.content] : []
    const reasoning =
      role === "assistant"
        ? (stringValue(value.reasoning_content) ?? stringValue(value.reasoning))
        : undefined
    if (reasoning) content.push({ type: "reasoning", text: reasoning })
    if (visibleText) content.push({ type: "text", text: visibleText })
    if (role === "user" && Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (!isRecord(part) || part.type !== "image_url") continue
        const image = imageSource(part.image_url)
        if (image) content.push({ type: "image", image })
      }
    }
    if (role === "assistant" && Array.isArray(value.tool_calls)) {
      for (const rawCall of value.tool_calls) {
        if (!isRecord(rawCall)) continue
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined
        const toolCallId = stringValue(rawCall.id)
        const nativeToolName = fn && stringValue(fn.name)
        if (!toolCallId || !nativeToolName) continue
        const parsedArgs = parseJson(String(fn?.arguments ?? "{}"))
        const unwrapped = unwrapTool(nativeToolName, jsonRecord(parsedArgs))
        const args = publicToolArgs(
          unwrapped.name,
          canonicalToolArgs(unwrapped.name, unwrapped.args)
        )
        const partIndex = content.length
        content.push({
          type: "tool-call",
          toolCallId,
          toolName: canonicalToolName(unwrapped.name),
          args,
          argsText: JSON.stringify(args),
        })
        calls.set(toolCallId, { messageIndex, partIndex })
      }
    }
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
      })
    }
  })
  return messages
}
