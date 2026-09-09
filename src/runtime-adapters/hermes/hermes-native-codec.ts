import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react"

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function parseJson(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function absoluteUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/$/, "")
  if (/^https?:\/\//u.test(base)) return `${base}${path}`
  if (typeof window === "undefined") return `${base}${path}`
  return new URL(`${base}${path}`, window.location.origin).toString()
}

export function websocketUrl(baseUrl: string) {
  const url = new URL(absoluteUrl(baseUrl, "/api/ws"))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

export function encodeHermesThreadId(profile: string, storedSessionId: string) {
  return `hermes:${encodeURIComponent(profile)}:${encodeURIComponent(storedSessionId)}`
}

export function decodeHermesThreadId(threadId: string) {
  const match = /^hermes:([^:]+):(.+)$/u.exec(threadId)
  if (!match) return undefined
  try {
    return {
      profile: decodeURIComponent(match[1]),
      storedSessionId: decodeURIComponent(match[2]),
    }
  } catch {
    return undefined
  }
}

export function isoTimestamp(value: unknown) {
  const numeric = numberValue(value)
  if (!numeric || numeric <= 0) return new Date(0).toISOString()
  return new Date(
    numeric < 10_000_000_000 ? numeric * 1000 : numeric
  ).toISOString()
}

/** Translate Hermes-native tool names at the single provider boundary. */
export function canonicalHermesToolName(name: string) {
  return (
    {
      delegate_task: "delegate_subagent",
      skill_view: "use_skill",
      todo_list: "todo",
      clarify: "question",
    }[name] ?? name
  )
}

export function canonicalHermesToolArgs(name: string, args: JsonRecord) {
  if (canonicalHermesToolName(name) !== "delegate_subagent") return args
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

function messageDate(value: JsonRecord, index: number) {
  const numeric = numberValue(value.timestamp ?? value.created_at)
  if (!numeric) return new Date(index)
  return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
}

/** Project native durable rows while retaining complete tool arguments/results. */
export function projectHermesHistory(rows: readonly unknown[]) {
  const messages: ThreadMessageLike[] = []
  const calls = new Map<string, { messageIndex: number; partIndex: number }>()
  rows.forEach((value, index) => {
    if (!isRecord(value) || value.display_kind === "hidden") return
    const role = stringValue(value.role)
    if (role === "tool") {
      const toolCallId = stringValue(value.tool_call_id ?? value.toolCallId)
      const target = toolCallId ? calls.get(toolCallId) : undefined
      if (!target) return
      const message = messages[target.messageIndex]
      if (
        !message ||
        message.role !== "assistant" ||
        !Array.isArray(message.content)
      )
        return
      const content = [...message.content]
      const part = content[target.partIndex]
      if (!part || part.type !== "tool-call") return
      content[target.partIndex] = {
        ...part,
        result: parseJson(value.content ?? value.result),
        ...(value.is_error === true ? { isError: true } : {}),
      }
      messages[target.messageIndex] = { ...message, content }
      return
    }
    if (role !== "user" && role !== "assistant" && role !== "system") return
    const id =
      value._row_id !== undefined
        ? `hermes-row-${String(value._row_id)}`
        : typeof value.id === "number" &&
            Number.isSafeInteger(value.id) &&
            value.id > 0
          ? `hermes-row-${value.id}`
          : (stringValue(value.id) ?? `hermes-history-${index}`)
    const rawContent = parseJson(value.content)
    const text = String(
      value.display_content ??
        value.text ??
        (Array.isArray(rawContent)
          ? rawContent
              .filter((part) => isRecord(part) && part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : rawContent) ??
        ""
    )
    const content: Array<JsonRecord & { type: string }> = text
      ? [{ type: "text", text }]
      : []
    if (role === "user" && Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (!isRecord(part) || part.type !== "image_url") continue
        const image = isRecord(part.image_url)
          ? part.image_url.url
          : part.image_url
        if (
          typeof image === "string" &&
          /^(?:data:image\/(?:png|jpeg|gif|webp|bmp);base64,|https?:\/\/)/u.test(
            image
          )
        )
          content.push({ type: "image", image })
      }
    }
    if (role === "assistant" && Array.isArray(value.tool_calls)) {
      for (const rawCall of value.tool_calls) {
        if (!isRecord(rawCall)) continue
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined
        const toolCallId = stringValue(rawCall.id)
        const nativeToolName = fn && stringValue(fn.name)
        if (!toolCallId || !nativeToolName) continue
        const argsText = String(fn?.arguments ?? "{}")
        const args = parseJson(argsText)
        const partIndex = content.length
        content.push({
          type: "tool-call",
          toolCallId,
          toolName: canonicalHermesToolName(nativeToolName),
          args: isRecord(args)
            ? canonicalHermesToolArgs(nativeToolName, args)
            : {},
          argsText,
        })
        calls.set(toolCallId, { messageIndex: messages.length, partIndex })
      }
    }
    messages.push({
      id,
      role,
      content: content as never,
      createdAt: messageDate(value, index),
    })
  })
  return messages
}

export function messageText(message: AppendMessage) {
  return message.content
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim()
}
