import type { SessionMessage } from "../protocol"

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

const credentialValue =
  /(?:\b(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credential|password|secret|token)\s*[=:]\s*\S+|\b(?:basic|bearer)\s+\S+|\b(?:gh[opsur]_\w+|sk-[\w-]+|xox[baprs]-\w+|eyJ[\w-]+\.[\w-]+\.[\w-]+))/iu
const privateLocationValue =
  /(?:^|[\s("'=])(?:\/(?:etc|home|root|srv|tmp|var)\/|[A-Za-z]:\\|file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s]*(?:hermes|internal|\.local))(?:[/:]|$))/iu

type ToolProjection = {
  args: readonly string[]
  results: readonly string[]
}

const searchProjection: ToolProjection = {
  args: ["query", "pattern", "glob", "include", "exclude", "filters", "limit"],
  results: [
    "ok",
    "status",
    "summary",
    "message",
    "count",
    "matches",
    "items",
    "results",
  ],
}
const activityProjection: ToolProjection = {
  args: ["description", "goal", "goals", "prompt", "task", "name", "skill"],
  results: ["name", "status", "summary", "message", "transcript"],
}
const receiptProjection: ToolProjection = {
  args: [
    "name",
    "description",
    "command",
    "start",
    "end",
    "line",
    "limit",
    "offset",
  ],
  results: ["ok", "status", "summary", "message", "count", "exitCode"],
}

/** Public fields are explicit; every retained nested value is sanitized again. */
const toolProjections: Readonly<Record<string, ToolProjection>> = {
  render_chart: {
    args: ["title", "type", "xKey", "series", "data"],
    results: [
      "ok",
      "status",
      "message",
      "title",
      "type",
      "xKey",
      "series",
      "data",
    ],
  },
  render_map: {
    args: ["title", "locations"],
    results: ["ok", "status", "message", "title", "locations"],
  },
  render_stats: {
    args: ["title", "description", "stats"],
    results: ["ok", "status", "message", "title", "description", "stats"],
  },
  present_plan: {
    args: ["id", "title", "steps"],
    results: ["ok", "status", "message", "id", "title", "steps"],
  },
  present_artifact: {
    args: ["id", "title", "filename", "mimeType", "sizeBytes"],
    results: ["ok", "status", "message"],
  },
  question: {
    args: ["question", "options", "allowFreeform", "multiple"],
    results: [
      "answer",
      "answers",
      "selected",
      "selectedOption",
      "selectedOptions",
      "text",
      "status",
    ],
  },
  ask_user_question: {
    args: ["question", "options", "allowFreeform", "multiple"],
    results: [
      "answer",
      "answers",
      "selected",
      "selectedOption",
      "selectedOptions",
      "text",
      "status",
    ],
  },
  request_permission: {
    args: ["action", "question", "reason", "description"],
    results: ["approved", "answer", "status", "message"],
  },
  request_approval: {
    args: ["action", "question", "reason", "description"],
    results: ["approved", "answer", "status", "message"],
  },
  delegate_subagent: activityProjection,
  run_subagent: activityProjection,
  task: activityProjection,
  use_skill: {
    args: ["skill", "name", "description"],
    results: ["name", "status", "summary", "message"],
  },
  load_skill: {
    args: ["skill", "name", "description"],
    results: ["name", "status", "summary", "message"],
  },
  todo: {
    args: ["action", "items", "todos", "title"],
    results: ["ok", "status", "summary", "message", "items", "todos"],
  },
  monty_execute: {
    args: ["code", "description"],
    results: ["ok", "status", "summary", "message", "output"],
  },
  web_search: searchProjection,
  search: searchProjection,
  find: searchProjection,
  grep: searchProjection,
  glob: searchProjection,
  read: receiptProjection,
  read_file: receiptProjection,
  write: receiptProjection,
  write_file: receiptProjection,
  edit: receiptProjection,
  apply_patch: receiptProjection,
  bash: receiptProjection,
  terminal: receiptProjection,
  execute_command: receiptProjection,
  tool_describe: {
    args: ["tool", "name", "description"],
    results: ["ok", "status", "summary", "message", "name", "description"],
  },
}

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
    if (
      value.length > MAX_PUBLIC_STRING_LENGTH ||
      credentialValue.test(value) ||
      privateLocationValue.test(value)
    )
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

function projectFields(value: unknown, fields: readonly string[]) {
  const parsed = parseJson(value)
  if (!isRecord(parsed)) return undefined
  const projected: JsonRecord = {}
  for (const field of fields) {
    if (!(field in parsed)) continue
    const item = publicJsonValue(parsed[field])
    if (item !== undefined) projected[field] = item
  }
  return projected
}

function publicToolArgs(name: string, args: JsonRecord): JsonRecord {
  const projection = toolProjections[canonicalToolName(name)]
  return projection ? (projectFields(args, projection.args) ?? {}) : {}
}

function publicToolResult(name: string, value: unknown, isError: boolean) {
  const projection = toolProjections[canonicalToolName(name)]
  if (!projection) return { status: isError ? "failed" : "completed" }
  const projected = projectFields(value, projection.results)
  if (projected && Object.keys(projected).length > 0) return projected
  const parsed = parseJson(value)
  if (typeof parsed === "string") {
    const text = publicJsonValue(parsed)
    if (typeof text === "string") return text
  }
  return { status: isError ? "failed" : "completed" }
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

function safeArtifactToken(value: string, maxLength: number) {
  return (
    value.length <= maxLength &&
    !/[\\/]/u.test(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    }) &&
    value !== "." &&
    value !== ".." &&
    !credentialValue.test(value) &&
    !privateLocationValue.test(value)
  )
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
    !safeArtifactToken(id, 256) ||
    !safeArtifactToken(filename, 255) ||
    (mimeType !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(
        mimeType
      )) ||
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
        result:
          artifact?.result ??
          publicToolResult(
            toolName,
            value.content ?? value.result,
            value.is_error === true
          ),
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
      })
    }
  })
  return messages
}
