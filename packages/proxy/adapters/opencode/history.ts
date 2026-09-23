import type { SessionMessage } from "../../../protocol"
import type { McpToolNameResolver } from "../../core/aos-tool-names"
import {
  openCodeStopReason,
  openCodeTimestamp,
  OpenCodeNativeMessageSchema,
  parseOpenCodeMessageCatalog,
} from "./native-schemas"
import { openCodeArtifactReceipt } from "./content"
import {
  canonicalOpenCodeToolCall,
  canonicalOpenCodeToolName,
  openCodeToolKind,
} from "./tool-names"

export type NativeMessage = typeof OpenCodeNativeMessageSchema._output
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

type NativeAssistantPart = Extract<
  NativeMessage,
  { type: "assistant" }
>["content"][number]

/** The artifact a completed `aos-ui` `present_artifact` call's receipt publishes. */
function toolArtifact(part: NativeAssistantPart) {
  if (
    part.type !== "tool" ||
    part.state.status !== "completed" ||
    canonicalOpenCodeToolName(part.name) !== "present_artifact"
  )
    return undefined
  const text = part.state.content
    .flatMap((item) =>
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
        ? [item.text]
        : []
    )
    .join("\n")
  return openCodeArtifactReceipt(part.id, text)
}

/**
 * Resolve an artifact id to its native path by scanning this Session's own
 * authoritative messages newest-first. Only a receipt the Session still holds
 * grants read authority, so an id from any other Session resolves to nothing.
 */
export function publishedOpenCodeArtifact(
  messages: readonly NativeMessage[],
  artifactId: string
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      const artifact = toolArtifact(part)
      if (artifact?.descriptor.id === artifactId) return artifact
    }
  }
  return undefined
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
            : publicJson(part.state.input)
        if (!args || typeof args !== "object" || Array.isArray(args)) continue
        const call = canonicalOpenCodeToolCall(
          part.name,
          args as { [key: string]: JsonValue },
          part.state.status === "completed"
            ? publicJson(part.state.result)
            : undefined,
          resolve
        )
        const kind = openCodeToolKind(call.toolName)
        const { completed } = part.time
        const artifact = toolArtifact(part)
        const result = artifact?.result ?? call.result
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
          ...(result === undefined ? {} : { result }),
          ...(part.state.status === "error" ? { isError: true } : {}),
        })
        if (artifact)
          content.push({
            type: "data",
            name: "aos.artifact",
            data: artifact.descriptor,
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
  const messages: ProjectedHistory = native
    .map((message) => projectMessage(message, input.resolve))
    .flatMap((message) => (message ? [message] : []))
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id)
    )
  return messages
}
