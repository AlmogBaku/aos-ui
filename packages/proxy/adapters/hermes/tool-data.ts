/**
 * The single owner of Hermes tool projection.
 *
 * Both the live stream (`run.ts`) and the authoritative durable rows
 * (`history.ts`) project a tool call through `projectHermesToolCall` and its
 * outcome through `projectHermesToolOutcome`, so the same native call cannot
 * read differently while streaming and after a refresh.
 */

import {
  canonicalToolName as canonicalMcpToolName,
  type McpToolNameResolver,
} from "../../core/aos-tool-names"
import {
  DiffOperation,
  ToolKind,
  type ToolDiff,
  type ToolLocation,
} from "../../core/events"

import {
  boundedGraphBytes,
  containsCredentialValue,
  isRecord,
  parseJson,
  parseJsonOrValue,
  trimmedText,
  unwrappedToolText,
  utf8BytesWithin,
} from "./native"
import {
  isCredentialPlaceholder,
  REDACTED,
  redactCredentials,
} from "@shared/credentials"
import {
  projectHermesArtifactReceipt,
  projectHermesMediaArtifacts,
} from "./media-artifacts"

/** Hermes' native tool names AOS renames. */
export const CANONICAL_TOOL_NAMES = new Map<string, string>([
  ["delegate_task", "delegate_subagent"],
  ["skill_view", "use_skill"],
  ["todo_list", "todo"],
  ["clarify", "question"],
])

const NO_MCP_TOOLS: McpToolNameResolver = () => undefined

/**
 * The public name of a native tool: an `aos-ui` MCP tool loses its prefix, and
 * another MCP tool `resolve` recognizes reads as `mcp__<server>__<tool>` under
 * its original names.
 */
export function canonicalToolName(
  name: string,
  resolve: McpToolNameResolver = NO_MCP_TOOLS
) {
  return CANONICAL_TOOL_NAMES.get(name) ?? canonicalMcpToolName(name, resolve)
}

/** What each canonical Hermes tool does; every other tool is `other`. */
const TOOL_KINDS = new Map<string, ToolKind>([
  ["read_file", ToolKind.Read],
  ["read_terminal", ToolKind.Read],
  ["use_skill", ToolKind.Read],
  ["write_file", ToolKind.Edit],
  ["patch", ToolKind.Edit],
  ["terminal", ToolKind.Execute],
  ["execute_code", ToolKind.Execute],
  ["process_manage", ToolKind.Execute],
  ["search_files", ToolKind.Search],
  ["session_search", ToolKind.Search],
  ["web_search", ToolKind.Search],
  ["x_search", ToolKind.Search],
  ["web_extract", ToolKind.Fetch],
  ["todo", ToolKind.Think],
])

export function hermesToolKind(canonicalName: string) {
  return TOOL_KINDS.get(canonicalName) ?? ToolKind.Other
}

/** The file tools whose `path` argument names the one file they touch. */
const FILE_TOOLS = new Set(["read_file", "write_file", "patch"])

/**
 * An absolute path that may leave the adapter: any one carrying no credential,
 * and none a projection already masked, since that no longer names the file.
 * Tool data reaches only the operator lane, which sees the Agent's real paths;
 * the guest projection drops tool calls before a path could reach it.
 */
export function publicPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes(REDACTED) &&
    !containsCredentialValue(value)
  )
}

/** The file a projected file-tool call touches, when its path is public. */
export function hermesToolLocations(
  canonicalName: string,
  args: HermesPublicJsonRecord
): ToolLocation[] | undefined {
  const path = args.path
  return FILE_TOOLS.has(canonicalName) && publicPath(path)
    ? [{ path }]
    : undefined
}

/**
 * The files a successful edit changed, from its native result. Hermes reports
 * every file an edit touched, moves and deletes included, as modified, and the
 * `patch` tool adds a unified diff of them; the diff travels only when every
 * file it names is public.
 */
export function hermesToolDiffs(
  canonicalName: string,
  result: unknown
): ToolDiff[] | undefined {
  if (canonicalName !== "write_file" && canonicalName !== "patch")
    return undefined
  const parsed = parseJsonOrValue(result)
  if (!isRecord(parsed) || !Array.isArray(parsed.files_modified))
    return undefined
  const paths = parsed.files_modified
  if (paths.length === 0 || !paths.every(publicPath)) return undefined
  const diff = parsed.diff
  return [
    {
      changes: paths.map((path) => ({ operation: DiffOperation.Modify, path })),
      ...(typeof diff === "string" && diff && !stringContainsCredential(diff)
        ? { patch: diff }
        : {}),
    },
  ]
}

export type HermesPublicJsonValue =
  | null
  | boolean
  | number
  | string
  | HermesPublicJsonValue[]
  | { [key: string]: HermesPublicJsonValue }

export type HermesPublicJsonRecord = Record<string, HermesPublicJsonValue>

const TRUNCATED = "[Truncated]"
const MAX_DEPTH = 6
const MAX_ENTRIES = 64
const MAX_KEY_LENGTH = 128
const MAX_STRING_LENGTH = 4_000
const MAX_TOTAL_STRING_LENGTH = 8_000

const SAFE_CREDENTIAL_LIKE_KEYS = new Set([
  "accesskeyrotation",
  "authmode",
  "authorizationmode",
  "oauth",
  "oauthmode",
  "secretary",
  "tokencount",
  "tokenlimit",
  "tokenusage",
])
const CREDENTIAL_WRAPPERS = new Set([
  "b64",
  "base64",
  "ciphertext",
  "digest",
  "encoded",
  "encrypted",
  "file",
  "hash",
  "hashed",
  "path",
  "salt",
  "sha256",
  "value",
])
type ProjectionState = {
  entries: number
  stringLength: number
  seen: WeakSet<object>
}

function normalizedKey(key: string) {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase()
}

function credentialToolKey(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean)
  const normalized = words.join("")
  if (SAFE_CREDENTIAL_LIKE_KEYS.has(normalized)) return false
  while (words.length > 1 && CREDENTIAL_WRAPPERS.has(words.at(-1) ?? ""))
    words.pop()
  const core = words.join("")
  const credentialTerms = [
    "pwd",
    "pass",
    "passcode",
    "password",
    "passwd",
    "passphrase",
    "privatekey",
    "secret",
    "secretkey",
    "token",
    "apikey",
    "accesskey",
    "accesskeyid",
    "auth",
    "authorization",
    "cookie",
    "cookiejar",
    "credential",
    "credentials",
  ]
  const prefix = words.slice(0, 2).join("")
  const suffix = words.slice(-2).join("")
  return (
    core === "npmconfiguserconfig" ||
    credentialTerms.some(
      (term) =>
        core === term ||
        core.endsWith(term) ||
        words[0] === term ||
        prefix === term ||
        suffix === term
    )
  )
}

function providerPrivateKey(key: string) {
  const normalized = normalizedKey(key)
  return (
    normalized.endsWith("sessionid") ||
    normalized.endsWith("liveid") ||
    normalized.endsWith("metadata") ||
    normalized === "nativeposition" ||
    normalized === "providermetadata"
  )
}

const ASSIGNMENT =
  /(^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*["'`]?)([^\s"'`]+)/gu

/**
 * Native text as a tool projection shows it: each credential-shaped value, and
 * each value assigned to a credential-named variable, masked in place. A value
 * that only names a secret (`$TOKEN`) stays readable.
 */
export function redactedText(value: string) {
  return redactCredentials(value).replace(
    ASSIGNMENT,
    (match, lead: string, key: string, operator: string, secret: string) =>
      credentialToolKey(key) && !isCredentialPlaceholder(secret)
        ? `${lead}${key}${operator}${REDACTED}`
        : match
  )
}

export function stringContainsCredential(value: string) {
  return redactedText(value) !== value
}

function projectString(value: string, state: ProjectionState) {
  const available = Math.max(
    0,
    Math.min(MAX_STRING_LENGTH, MAX_TOTAL_STRING_LENGTH - state.stringLength)
  )
  if (available === 0) return TRUNCATED
  const projected = truncateString(redactedText(value), available)
  state.stringLength += projected.length
  return projected
}

function truncateString(value: string, maximum: number) {
  if (value.length <= maximum) return value
  const contentMaximum = Math.max(0, maximum - TRUNCATED.length)
  let content = ""
  for (const character of value) {
    if (content.length + character.length > contentMaximum) break
    content += character
  }
  return `${content}${TRUNCATED}`
}

function projectValue(
  value: unknown,
  state: ProjectionState,
  depth: number
): HermesPublicJsonValue | undefined {
  if (typeof value === "string") return projectString(value, state)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (depth >= MAX_DEPTH || state.entries >= MAX_ENTRIES) return TRUNCATED
  if (typeof value !== "object") return undefined
  if (state.seen.has(value)) return TRUNCATED
  state.seen.add(value)

  if (Array.isArray(value)) {
    const result: HermesPublicJsonValue[] = []
    for (const item of value) {
      if (state.entries >= MAX_ENTRIES) {
        result.push(TRUNCATED)
        break
      }
      state.entries += 1
      const projected = projectValue(item, state, depth + 1)
      if (projected !== undefined) result.push(projected)
    }
    return result
  }

  const result: HermesPublicJsonRecord = {}
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return undefined
  }
  for (const key of keys) {
    if (state.entries >= MAX_ENTRIES) {
      result[TRUNCATED] = TRUNCATED
      break
    }
    if (key.length > MAX_KEY_LENGTH || providerPrivateKey(key)) continue
    state.entries += 1
    if (credentialToolKey(key)) {
      result[key] = REDACTED
      continue
    }
    let item: unknown
    try {
      item = Reflect.get(value, key)
    } catch {
      continue
    }
    const projected = projectValue(item, state, depth + 1)
    if (projected !== undefined) result[key] = projected
  }
  return result
}

/**
 * Hermes integrations do not consistently set `is_error` on durable tool
 * rows. Preserve an explicit native flag, then recognize the small set of
 * result envelopes that unambiguously represent failure.
 */
function hermesToolResultIsError(
  value: unknown,
  nativeIsError = false
): boolean {
  if (nativeIsError) return true
  const parsed = parseJsonOrValue(value)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false
  const result = parsed as Record<string, unknown>
  if (result.success === false || result.ok === false) return true
  return (
    typeof result.status === "string" &&
    ["error", "failed", "failure"].includes(result.status.toLowerCase())
  )
}

function project(value: unknown) {
  return projectValue(
    parseJsonOrValue(value),
    {
      entries: 0,
      stringLength: 0,
      seen: new WeakSet(),
    },
    0
  )
}

/**
 * Projects operator-visible tool arguments without carrying provider session
 * metadata or credentials into the browser. Guest projections discard tool
 * calls before reaching this boundary.
 */
function projectHermesToolArgs(value: unknown): HermesPublicJsonRecord {
  const projected = project(value)
  return projected && typeof projected === "object" && !Array.isArray(projected)
    ? projected
    : {}
}

/** Projects the inspectable result recorded for an operator-visible tool call. */
function projectHermesToolResult(
  value: unknown,
  isError = false
): HermesPublicJsonValue {
  const projected = project(value)
  return projected ?? { status: isError ? "failed" : "completed" }
}

// ---------------------------------------------------------------------------
// Native tool identity
// ---------------------------------------------------------------------------

type NativeToolArgs = Record<string, unknown>

/** Longest native tool name accepted from a bridge envelope. */
const MAX_TOOL_NAME_LENGTH = 512
/** Largest serialized bridge payload that is unwrapped rather than kept whole. */
const MAX_TOOL_PAYLOAD_BYTES = 65_536

function nativeToolArgs(value: unknown): NativeToolArgs {
  const parsed = parseJsonOrValue(value)
  return isRecord(parsed) ? parsed : {}
}

/**
 * The selected payload of a bridge envelope, or `undefined` when it is absent,
 * not a record, or larger than one tool payload may be. Hermes writes it either
 * as a JSON string or as a nested object, and both obey the same bound.
 */
function boundedSelection(value: unknown) {
  if (typeof value === "string")
    return utf8BytesWithin(value, MAX_TOOL_PAYLOAD_BYTES) === undefined
      ? undefined
      : parseJson(value)
  return boundedGraphBytes(value, MAX_TOOL_PAYLOAD_BYTES) === undefined
    ? undefined
    : value
}

/** One native tool a bridge envelope selected, with the arguments it recorded. */
export type HermesToolSelection = { name: string; args: NativeToolArgs }

function toolSelection(value: unknown): HermesToolSelection | undefined {
  if (!isRecord(value)) return undefined
  const name = trimmedText(value.name)
  if (!name || name.length > MAX_TOOL_NAME_LENGTH) return undefined
  const args = boundedSelection(value.arguments)
  return isRecord(args) ? { name, args } : undefined
}

/**
 * The tools Hermes' tool-search bridge selected inside a `tool_call` envelope,
 * in the order it recorded them. Hermes writes either one selection inline or a
 * `calls` batch of them, and a selection counts only when the envelope names it
 * and carries its arguments as a bounded record. An envelope that selected
 * nothing usable reports nothing, so its caller keeps the envelope.
 */
export function toolCallSelections(
  name: string,
  value: unknown
): HermesToolSelection[] {
  if (name !== "tool_call") return []
  const args = nativeToolArgs(value)
  const batch = boundedSelection(args.calls)
  if (Array.isArray(batch))
    return batch.flatMap((call) => toolSelection(call) ?? [])
  const selection = toolSelection(args)
  return selection ? [selection] : []
}

/**
 * The single tool one native call stands for. A `tool_call` envelope that
 * selected exactly one tool reads as that tool; a batch of several stays the
 * envelope, because one public tool call cannot honestly carry two names and
 * the operator can still inspect the batch it shows instead.
 */
export function unwrapToolCall(
  name: string,
  value: unknown
): HermesToolSelection {
  const args = nativeToolArgs(value)
  const [selection, ...rest] = toolCallSelections(name, args)
  return selection && rest.length === 0 ? selection : { name, args }
}

// ---------------------------------------------------------------------------
// Argument canonicalization
// ---------------------------------------------------------------------------

const PUBLIC_ARTIFACT_ARG_KEYS = [
  "id",
  "title",
  "filename",
  "mimeType",
  "sizeBytes",
]
const PUBLIC_ARTIFACT_RECEIPT_KEYS = ["ok", "status", "message"]
const DELEGATE_DESCRIPTION_FALLBACK_KEYS = [
  "goal",
  "goals",
  "prompt",
  "task",
  "name",
  "skill",
]

function choiceList(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (choice): choice is string =>
          typeof choice === "string" && choice.trim().length > 0
      )
    : []
}

function batchedQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const question = trimmedText(candidate.question)
    if (!question) return []
    const options = choiceList(candidate.choices)
    return [
      {
        question,
        ...(options.length ? { options } : {}),
        allowFreeform: options.length === 0,
        multiple: candidate.multi_select === true,
      },
    ]
  })
}

/**
 * Rewrites native argument shapes into the ones the public tool renderers read:
 * Hermes' clarification choices become renderable questions and a delegated
 * subagent always carries a description.
 */
export function canonicalToolArgs(
  name: string,
  args: NativeToolArgs
): NativeToolArgs {
  const canonicalName = canonicalToolName(name)
  if (canonicalName === "question") {
    const questions = batchedQuestions(args.questions)
    if (questions.length)
      return {
        question: `${questions.length} ${questions.length === 1 ? "question" : "questions"}`,
        questions,
        // This keeps the existing question renderer valid while its settled
        // receipt reads the richer batched shape above.
        allowFreeform: true,
      }
    const { choices, multi_select, allow_freeform, ...rest } = args
    const options = choiceList(choices)
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
  if (canonicalName !== "delegate_subagent") return args
  if (trimmedText(args.description)) return args
  const candidate = DELEGATE_DESCRIPTION_FALLBACK_KEYS.map((key) => args[key])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => trimmedText(value))
    .find(Boolean)
  return candidate ? { ...args, description: candidate } : args
}

function publicToolArgs(
  name: string,
  args: NativeToolArgs
): HermesPublicJsonRecord {
  const projected = projectHermesToolArgs(args)
  if (canonicalToolName(name) !== "present_artifact") return projected
  const artifactArgs: HermesPublicJsonRecord = {}
  for (const key of PUBLIC_ARTIFACT_ARG_KEYS)
    if (key in projected) artifactArgs[key] = projected[key]!
  return artifactArgs
}

/** The public name and arguments of one native Hermes tool call. */
export function projectHermesToolCall(
  name: string,
  args: unknown,
  resolve?: McpToolNameResolver
) {
  const unwrapped = unwrapToolCall(name, args)
  return {
    toolName: canonicalToolName(unwrapped.name, resolve),
    args: publicToolArgs(
      unwrapped.name,
      canonicalToolArgs(unwrapped.name, unwrapped.args)
    ),
  }
}

// ---------------------------------------------------------------------------
// Outcome projection
// ---------------------------------------------------------------------------

/** Longest recorded clarification answer that stays inspectable. */
const MAX_PUBLIC_ANSWER_LENGTH = 4_000

function publicAnswer(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PUBLIC_ANSWER_LENGTH &&
    !stringContainsCredential(value)
    ? value
    : undefined
}

/**
 * Projects the answers Hermes recorded for a settled clarification. An answer
 * that carries a credential is dropped rather than rewritten, so a cancelled
 * and a redacted clarification read alike.
 */
/**
 * Hermes records a multi-select answer as a list and a single one as text; an
 * older gateway encoded the list as JSON text. Anything else recorded nothing.
 */
function recordedAnswers(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value !== "string") return undefined
  if (!value) return []
  const decoded = parseJson(value)
  return Array.isArray(decoded) ? decoded : [value]
}

function projectQuestionResponses(
  value: unknown
): HermesPublicJsonRecord | undefined {
  const parsed = parseJsonOrValue(value)
  if (!isRecord(parsed) || !Array.isArray(parsed.responses)) return undefined
  const responses = parsed.responses.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const question = trimmedText(candidate.question)
    const chosen = recordedAnswers(candidate.user_response)
    if (!question || !chosen) return []
    const answers = chosen.flatMap((answer) => publicAnswer(answer) ?? [])
    return [{ question, answers }]
  })
  if (!responses.length) return undefined
  return {
    status: responses.some(({ answers }) => answers.length)
      ? "answered"
      : "cancelled",
    responses,
  }
}

function publicToolResult(
  name: string,
  value: unknown,
  isError: boolean
): HermesPublicJsonValue {
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
    typeof projected !== "object" ||
    projected === null ||
    Array.isArray(projected)
  )
    return projected
  // An artifact receipt AOS could not publish keeps only its status fields: the
  // rest of a native receipt is a filesystem path.
  const receipt: HermesPublicJsonRecord = {}
  for (const key of PUBLIC_ARTIFACT_RECEIPT_KEYS)
    if (key in projected) receipt[key] = projected[key]!
  return Object.keys(receipt).length
    ? receipt
    : { status: isError ? "failed" : "completed" }
}

type HermesArtifactReceipt = NonNullable<
  ReturnType<typeof projectHermesArtifactReceipt>
>
type HermesMediaDescriptor = ReturnType<
  typeof projectHermesMediaArtifacts
>[number]["descriptor"]

export type HermesToolDataPart =
  | HermesArtifactReceipt["part"]
  | { type: "data"; name: string; data: HermesMediaDescriptor }

export type HermesToolOutcome = {
  /** Whether the tool failed, from the native flag or its result envelope. */
  isError: boolean
  /** The inspectable result the operator sees. */
  result: HermesPublicJsonValue | HermesArtifactReceipt["result"]
  /** Public artifact descriptors this outcome publishes, in emission order. */
  parts: HermesToolDataPart[]
  /** Native references this outcome grants media authority to. */
  trustedMedia: string[]
}

/**
 * The public outcome of one native Hermes tool call: error classification, the
 * inspectable result, and the artifact descriptors the outcome publishes. A
 * failed tool publishes nothing, so no receipt can grant authority to media the
 * provider never produced.
 */
export function projectHermesToolOutcome(
  toolCallId: string,
  name: string,
  wrapped: unknown,
  nativeIsError = false
): HermesToolOutcome {
  const result = unwrappedToolText(wrapped)
  const canonicalName = canonicalToolName(name)
  const isError = hermesToolResultIsError(result, nativeIsError)
  const artifact =
    canonicalName === "present_artifact" && !isError
      ? projectHermesArtifactReceipt(toolCallId, result)
      : undefined
  const media = isError
    ? []
    : projectHermesMediaArtifacts(toolCallId, canonicalName, result)
  return {
    isError,
    result:
      artifact?.result ?? publicToolResult(canonicalName, result, isError),
    parts: [
      ...(artifact ? [artifact.part] : []),
      ...media.map(({ descriptor }) => ({
        type: "data" as const,
        name: "aos.artifact",
        data: descriptor,
      })),
    ],
    trustedMedia: media.map(({ reference }) => reference),
  }
}
