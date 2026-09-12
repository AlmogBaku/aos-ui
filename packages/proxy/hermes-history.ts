import type { SessionMessage } from "../protocol"

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonRecord = Record<string, JsonValue>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function timestamp(value: unknown, index: number) {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0)
    return new Date(index).toISOString()
  return new Date(
    numeric < 10_000_000_000 ? numeric * 1000 : numeric
  ).toISOString()
}

function canonicalToolName(name: string) {
  return (
    {
      delegate_task: "delegate_subagent",
      skill_view: "use_skill",
      todo_list: "todo",
      clarify: "question",
    }[name] ?? name
  )
}

function canonicalToolArgs(name: string, args: JsonRecord) {
  if (name === "clarify") {
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

function unwrapTool(name: string, args: JsonRecord) {
  if (name !== "tool_call") return { name, args }
  const selectedName = stringValue(args.name)
  const selectedArgs = parseJson(args.arguments)
  if (!selectedName || !isRecord(selectedArgs)) return { name, args }
  return { name: selectedName, args: selectedArgs }
}

function artifactReceipt(raw: unknown) {
  const value = parseJson(raw)
  if (!isRecord(value) || value.ok !== true || value.type !== "aos.artifact")
    return undefined
  const artifact = value.artifact
  if (!isRecord(artifact)) return undefined
  const id = stringValue(artifact.id)
  const filename = stringValue(artifact.filename)
  const mimeType = stringValue(artifact.mimeType)
  const sizeBytes = artifact.sizeBytes
  if (
    !id ||
    !filename ||
    (sizeBytes !== undefined &&
      (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0))
  )
    return undefined
  const descriptor = {
    id,
    filename,
    ...(mimeType ? { mimeType } : {}),
    ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
  }
  return {
    result: { ok: true, type: "aos.artifact", artifact: descriptor },
    part: {
      type: "data" as const,
      name: "aos.artifact",
      data: {
        ...descriptor,
        source: { type: "provider", reference: `artifact:${id}` },
      },
    },
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

/** Converts provider-native durable rows into the strict public history shape. */
export function projectHermesHistory(
  rows: readonly unknown[]
): SessionMessage[] {
  const messages: SessionMessage[] = []
  const calls = new Map<string, { messageIndex: number; partIndex: number }>()

  rows.forEach((value, index) => {
    if (!isRecord(value) || value.display_kind === "hidden") return
    const role = stringValue(value.role)
    if (role === "tool") {
      const toolCallId = stringValue(value.tool_call_id ?? value.toolCallId)
      const target = toolCallId ? calls.get(toolCallId) : undefined
      if (!target) return
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
      const artifact =
        toolName === "present_artifact" && value.is_error !== true
          ? artifactReceipt(value.content ?? value.result)
          : undefined
      const content = [...message.content]
      content[target.partIndex] = {
        ...part,
        ...(resultToolName ? { toolName } : {}),
        result: artifact?.result ?? parseJson(value.content ?? value.result),
        ...(value.is_error === true ? { isError: true } : {}),
      }
      if (artifact) content.push(artifact.part)
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
    const previousAssistant =
      role === "assistant" && messages.at(-1)?.role === "assistant"
        ? messages.at(-1)
        : undefined
    const messageIndex = previousAssistant
      ? messages.length - 1
      : messages.length
    const rawContent = parseJson(value.content)
    const text = String(
      value.display_content ??
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
    const content = previousAssistant ? [...previousAssistant.content] : []
    const reasoning =
      role === "assistant"
        ? (stringValue(value.reasoning_content) ?? stringValue(value.reasoning))
        : undefined
    if (reasoning) content.push({ type: "reasoning", text: reasoning })
    if (text) content.push({ type: "text", text })
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
        const args = canonicalToolArgs(unwrapped.name, unwrapped.args)
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
      })
    }
  })
  return messages
}
