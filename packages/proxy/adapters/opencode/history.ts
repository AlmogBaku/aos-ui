import type { SessionMessage } from "../../../protocol"
import {
  openCodeStopReason,
  openCodeTimestamp,
  parseOpenCodeMessageCatalog,
  type OpenCodeNativeMessageSchema,
} from "./native-schemas"
import { canonicalOpenCodeToolCall, openCodeToolKind } from "./tool-names"

type NativeMessage = typeof OpenCodeNativeMessageSchema._output
type ProjectedHistory = SessionMessage[]
type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function safeFilename(value: string | undefined) {
  return value &&
    !/[\\/]/u.test(value) &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127
    })
    ? value
    : undefined
}

function safeImage(url: string) {
  return /^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/u.test(url)
    ? url
    : undefined
}

function publicJson(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 8) return undefined
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (typeof value === "string")
    return value.length <= 4_000 ? value : undefined
  if (Array.isArray(value))
    return value.slice(0, 100).flatMap((item) => {
      const projected = publicJson(item, depth + 1)
      return projected === undefined ? [] : [projected]
    })
  if (!value || typeof value !== "object") return undefined
  const result: { [key: string]: JsonValue } = {}
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/(?:credential|metadata|password|path|secret|token|url)$/iu.test(key))
      continue
    const projected = publicJson(item, depth + 1)
    if (projected !== undefined) result[key] = projected
  }
  return result
}

function projectMessage(message: NativeMessage): SessionMessage | undefined {
  const createdAt = openCodeTimestamp(message.time.created)
  if (message.type === "user") {
    const content: SessionMessage["content"] = [
      { type: "text", text: message.text },
    ]
    for (const file of message.files ?? []) {
      const image = safeImage(file.uri)
      if (image)
        content.push({
          type: "image",
          image,
          ...(safeFilename(file.name)
            ? { filename: safeFilename(file.name) }
            : {}),
        })
    }
    return { id: message.id, role: "user", createdAt, content }
  }
  if (message.type === "assistant") {
    const content: SessionMessage["content"] = []
    for (const part of message.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text })
      if (part.type === "reasoning")
        content.push({ type: "reasoning", text: part.text })
      if (part.type === "tool") {
        const args =
          part.state.status === "pending"
            ? parseToolInput(part.state.input)
            : publicJson(part.state.input)
        if (!args || typeof args !== "object" || Array.isArray(args)) continue
        const call = canonicalOpenCodeToolCall(
          part.name,
          args as { [key: string]: JsonValue },
          part.state.status === "completed"
            ? publicJson(part.state.result)
            : undefined
        )
        const kind = openCodeToolKind(call.toolName)
        const { completed } = part.time
        content.push({
          type: "tool-call",
          toolCallId: part.id,
          toolName: call.toolName,
          ...(kind ? { kind } : {}),
          startedAt: openCodeTimestamp(part.time.created),
          ...(completed === undefined
            ? {}
            : { completedAt: openCodeTimestamp(completed) }),
          args: call.args,
          argsText:
            part.state.status === "pending"
              ? part.state.input
              : JSON.stringify(call.args),
          ...(call.result === undefined ? {} : { result: call.result }),
          ...(part.state.status === "error" ? { isError: true } : {}),
        })
      }
    }
    return content.length
      ? {
          id: message.id,
          role: "assistant",
          createdAt,
          content,
          ...(message.finish
            ? { stopReason: openCodeStopReason(message.finish) }
            : {}),
        }
      : undefined
  }
  if (message.type === "system" || message.type === "synthetic")
    return {
      id: message.id,
      role: "system",
      createdAt,
      content: [{ type: "text", text: message.text }],
    }
  if (message.type === "compaction")
    return {
      id: message.id,
      role: "system",
      createdAt,
      content: [{ type: "text", text: message.summary }],
    }
  return undefined
}

function parseToolInput(value: string): JsonValue {
  try {
    return publicJson(JSON.parse(value) as unknown) ?? {}
  } catch {
    return {}
  }
}

export function projectOpenCodeHistory(input: {
  messages: unknown
  sessionId: string
}): ProjectedHistory {
  const parsedMessages = Array.isArray(input.messages)
    ? parseOpenCodeMessageCatalog({ data: input.messages, cursor: {} })
    : parseOpenCodeMessageCatalog(input.messages)
  if (!parsedMessages.success) return []
  const messages: ProjectedHistory = parsedMessages.data.data
    .map(projectMessage)
    .flatMap((message) => (message ? [message] : []))
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id)
    )
  return messages
}
