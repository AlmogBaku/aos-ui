import type { SessionMessage } from "../../../protocol"
import type { McpToolNameResolver } from "../../core/aos-tool-names"
import { publicJsonValue, type JsonValue } from "../json-value"
import {
  openCodeStopReason,
  openCodeThoughtId,
  openCodeTimestamp,
  OpenCodeNativeMessageSchema,
  parseOpenCodeMessageCatalog,
} from "./native-schemas"
import { canonicalOpenCodeToolCall, openCodeToolKind } from "./tool-names"

export type NativeMessage = typeof OpenCodeNativeMessageSchema._output
type ProjectedHistory = SessionMessage[]

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

/**
 * A native message as the messages a client reads: a response's reasoning is
 * its own thought, ahead of the response, as it streamed live.
 */
function projectMessages(
  message: NativeMessage,
  resolve?: McpToolNameResolver
): SessionMessage[] {
  const projected = projectMessage(message, resolve)
  if (projected?.role !== "assistant") return projected ? [projected] : []
  const thought = projected.content.filter(({ type }) => type === "reasoning")
  const response = projected.content.filter(({ type }) => type !== "reasoning")
  return [
    ...(thought.length
      ? [
          {
            id: openCodeThoughtId(projected.id),
            role: "assistant" as const,
            createdAt: projected.createdAt,
            content: thought,
          },
        ]
      : []),
    ...(response.length ? [{ ...projected, content: response }] : []),
  ]
}

/**
 * How many messages these native messages project to. Name resolution only
 * renames tool calls, so the count needs no MCP names loaded.
 */
export function openCodeProjectedCount(messages: readonly NativeMessage[]) {
  let count = 0
  for (const message of messages) count += projectMessages(message).length
  return count
}

function projectMessage(
  message: NativeMessage,
  resolve?: McpToolNameResolver
): SessionMessage | undefined {
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
            : publicJsonValue(part.state.input)
        const objectArgs =
          args !== null && typeof args === "object" && !Array.isArray(args)
        const safeArgs: { [key: string]: JsonValue } = objectArgs
          ? (args as { [key: string]: JsonValue })
          : {}
        const call = canonicalOpenCodeToolCall(
          part.name,
          safeArgs,
          part.state.status === "completed"
            ? publicJsonValue(part.state.result)
            : undefined,
          resolve
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
          // A pending call's raw input stands for its arguments only when it
          // parsed as the object the arguments were taken from.
          argsText:
            part.state.status === "pending" && objectArgs
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
    return publicJsonValue(JSON.parse(value) as unknown) ?? {}
  } catch {
    return {}
  }
}

/** Every raw tool name the messages carry, so their MCP names load before projection. */
export function openCodeHistoryToolNames(messages: readonly NativeMessage[]) {
  const names = new Set<string>()
  for (const message of messages)
    if (message.type === "assistant")
      for (const part of message.content)
        if (part.type === "tool") names.add(part.name)
  return names
}

export function projectOpenCodeHistory(input: {
  messages: unknown
  sessionId: string
  resolve?: McpToolNameResolver
}): ProjectedHistory {
  // An array is the adapter's accumulated read of many native pages, so only a
  // single native page is held to the page schema's row bound.
  const parsedMessages = Array.isArray(input.messages)
    ? OpenCodeNativeMessageSchema.array().safeParse(input.messages)
    : parseOpenCodeMessageCatalog(input.messages)
  if (!parsedMessages.success) return []
  const native = Array.isArray(parsedMessages.data)
    ? parsedMessages.data
    : parsedMessages.data.data
  const created = (message: NativeMessage) =>
    Date.parse(openCodeTimestamp(message.time.created))
  return [...native]
    .sort(
      (left, right) =>
        created(left) - created(right) || left.id.localeCompare(right.id)
    )
    .flatMap((message) => projectMessages(message, input.resolve))
}
