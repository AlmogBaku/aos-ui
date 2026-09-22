import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { parseAllDocuments } from "yaml"
import type { z } from "zod"

import { ProxyConfigSchema, type ProxyConfig } from "./config"

/**
 * The private proxy configuration file: where it is found, how it is read, and
 * how a rejected one is reported. Operator configuration is checked rather than
 * trusted, and no error it raises ever carries an input value: the file holds
 * paths, but the same file is what points the runtime at a host and can widen
 * the unauthenticated operator listener.
 */

/** Set by an operator following the pre-YAML documentation; never read. */
const LEGACY_PATH_VARIABLE = "AOS_RUNTIME_PROXY_CONFIG"
const PATH_VARIABLE = "AOS_UI_PROXY_CONFIG_FILE"
const EXPLICIT_PATH_HINT = `pass --config <path> or set ${PATH_VARIABLE}`
const MAXIMUM_SIZE_BYTES = 1_024 * 1_024
/** A merge writes into these, which is where pollution would be introduced. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

export class ProxyConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProxyConfigurationError"
  }
}

export type ProxyEnvReader = (name: string) => string | undefined

export type ProxyConfigPathSource = {
  /** `--config`, the only source that outranks the environment. */
  flag?: string
  getenv: ProxyEnvReader
  /** `invite` resolves no default path, because minting a bearer link is opt-in. */
  discover?: boolean
}

/** Only the facts the loader checks, so a test can state them as literals. */
export type ProxyConfigFileFacts = {
  isFile(): boolean
  mode: number
  uid: number
  size: number
}

export type ProxyConfigFileAccess = {
  stat: (path: string) => Promise<ProxyConfigFileFacts>
  readFile: (path: string, encoding: "utf8") => Promise<string>
  /** Absent on a platform without uids, which fails the ownership check. */
  getuid?: () => number
}

/** Compose `${VAR:-}` and systemd `EnvironmentFile` both produce empty values. */
function trimmed(value: string | undefined) {
  const text = value?.trim()
  return text === undefined || text === "" ? undefined : text
}

export function resolveProxyConfigPath({
  flag,
  getenv,
  discover = true,
}: ProxyConfigPathSource): { path: string; explicit: boolean } {
  if (trimmed(getenv(LEGACY_PATH_VARIABLE)) !== undefined)
    throw new ProxyConfigurationError(
      `${LEGACY_PATH_VARIABLE} is no longer read; ${EXPLICIT_PATH_HINT}`
    )
  const explicitPath = trimmed(flag) ?? trimmed(getenv(PATH_VARIABLE))
  if (explicitPath !== undefined) return { path: explicitPath, explicit: true }
  if (!discover)
    throw new ProxyConfigurationError(
      `No proxy configuration file: ${EXPLICIT_PATH_HINT}`
    )
  const configHome = trimmed(getenv("XDG_CONFIG_HOME"))
  if (configHome !== undefined && !isAbsolute(configHome))
    throw new ProxyConfigurationError(
      "XDG_CONFIG_HOME must be an absolute path"
    )
  const home = trimmed(getenv("HOME"))
  const searchRoot =
    configHome ?? (home === undefined ? undefined : join(home, ".config"))
  if (searchRoot === undefined)
    throw new ProxyConfigurationError(
      `No proxy configuration file: ${EXPLICIT_PATH_HINT}, or set XDG_CONFIG_HOME or HOME so the default configuration path can be resolved`
    )
  return { path: join(searchRoot, "aos-ui", "proxy.yaml"), explicit: false }
}

/** The real file access `serve` and `invite` read configuration through. */
export function nodeConfigFileAccess(
  overrides: Partial<ProxyConfigFileAccess> = {}
): ProxyConfigFileAccess {
  return {
    stat: overrides.stat ?? stat,
    readFile: overrides.readFile ?? readFile,
    getuid: overrides.getuid ?? process.getuid?.bind(process),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failureCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "unknown"
}

/**
 * Reads the configured file, or reports nothing to read. A discovered path that
 * does not exist is an empty document, because a deployment configured entirely
 * through the environment is legitimate; an explicit one is an error.
 */
async function readConfigFile(
  path: string,
  explicit: boolean,
  access: ProxyConfigFileAccess
): Promise<string | undefined> {
  let facts: ProxyConfigFileFacts
  try {
    // Symlinks are followed on purpose: a dotfile manager links `~/.config`.
    facts = await access.stat(path)
  } catch (error) {
    const code = failureCode(error)
    if (code === "ENOENT") {
      if (explicit)
        throw new ProxyConfigurationError(`${path}: no such configuration file`)
      return undefined
    }
    throw new ProxyConfigurationError(
      `${path}: the configuration file cannot be read (${code})`
    )
  }
  if (!facts.isFile())
    throw new ProxyConfigurationError(
      `${path}: the configuration file must be a regular file`
    )
  if ((facts.mode & 0o022) !== 0)
    throw new ProxyConfigurationError(
      `${path}: the configuration file must not be group- or world-writable`
    )
  const uid = access.getuid?.()
  if (uid === undefined)
    throw new ProxyConfigurationError(
      `${path}: the configuration file owner cannot be checked without a process uid`
    )
  if (facts.uid !== uid && facts.uid !== 0)
    throw new ProxyConfigurationError(
      `${path}: the configuration file must be owned by this user or by root`
    )
  if (facts.size > MAXIMUM_SIZE_BYTES)
    throw new ProxyConfigurationError(
      `${path}: the configuration file is larger than the ${MAXIMUM_SIZE_BYTES} byte limit`
    )
  try {
    return await access.readFile(path, "utf8")
  } catch (error) {
    throw new ProxyConfigurationError(
      `${path}: the configuration file cannot be read (${failureCode(error)})`
    )
  }
}

/** `prettyErrors: false` keeps the source out of the message and of `linePos`. */
function sourceLine(source: string, offset: number) {
  return source.slice(0, offset).split("\n").length
}

/**
 * Parses one hardened document. Any parser error or warning fails the load: an
 * unresolved custom tag is only a warning, and its message quotes the input.
 */
function parseConfigDocument(path: string, source: string) {
  const documents = parseAllDocuments(source, {
    logLevel: "silent",
    prettyErrors: false,
  })
  if (documents.length > 1)
    throw new ProxyConfigurationError(
      `${path}: the configuration file must hold a single YAML document`
    )
  const document = documents[0]
  if (document === undefined) return {}
  const problem = document.errors[0] ?? document.warnings[0]
  if (problem !== undefined)
    throw new ProxyConfigurationError(
      `${path}: invalid YAML (${problem.code} at line ${sourceLine(
        source,
        problem.pos[0]
      )})`
    )
  let content: unknown
  try {
    // An alias has no legitimate use here and would share objects into the merge.
    content = document.toJS({ maxAliasCount: 0 })
  } catch {
    throw new ProxyConfigurationError(
      `${path}: YAML anchors and aliases are not allowed in configuration`
    )
  }
  if (content === null || content === undefined) return {}
  if (!isRecord(content))
    throw new ProxyConfigurationError(
      `${path}: the configuration document must be a mapping`
    )
  assertSafeKeys(path, content)
  return content
}

function assertSafeKeys(path: string, value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeKeys(path, item)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key))
      throw new ProxyConfigurationError(
        `${path}: the configuration key "${key}" is not allowed`
      )
    assertSafeKeys(path, child)
  }
}

/**
 * Built-in defaults, deep-merged under the file and the environment. They are
 * never mutated, because every merge writes into a fresh object.
 */
const DEFAULT_PROXY_CONFIG: Record<string, unknown> = {
  version: 1,
  listen: { host: "127.0.0.1", port: 4_100 },
  limits: {
    activeExecutions: 256,
    guestActiveExecutions: 32,
    operatorEventPeers: 256,
    subscriberEvents: 512,
    subscriberBytes: 2_097_152,
  },
  shutdownGraceMs: 5_000,
}

/** Hermes is the only runtime with a default of its own. */
const DEFAULT_HERMES_SESSION_IDLE_MS = 300_000

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key]
    // A sequence replaces wholesale; only mappings merge.
    merged[key] =
      isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value
  }
  return merged
}

export const PROXY_ENV_PREFIX = "AOS_UI_PROXY_"

const RUNTIME_KINDS = ["hermes", "opencode", "openclaw"] as const

type RuntimeKind = (typeof RUNTIME_KINDS)[number]

export type ProxyEnvOverride = {
  path: string[]
  /** Appended to `AOS_UI_PROXY_` to form the variable an operator exports. */
  suffix: string
  type: "string" | "int"
  /**
   * The runtime branch this row belongs to, or `guest` for a row that may only
   * fill a lane the file already opened.
   */
  appliesWhen?: RuntimeKind | "guest"
}

/**
 * One row per scalar leaf of the schema, so the overrides are a list an
 * operator can read rather than a schema walk. `version` has no row, arrays are
 * file-only, and `AOS_UI_PROXY_TARGET`, `_HOST`, `_PORT` and `_CONFIG_FILE`
 * belong to other features.
 */
export const PROXY_ENV_OVERRIDES: readonly ProxyEnvOverride[] = [
  { path: ["deploymentId"], suffix: "DEPLOYMENT_ID", type: "string" },
  { path: ["publicOrigin"], suffix: "PUBLIC_ORIGIN", type: "string" },
  { path: ["listen", "host"], suffix: "LISTEN_HOST", type: "string" },
  { path: ["listen", "port"], suffix: "LISTEN_PORT", type: "int" },
  { path: ["listen", "exposure"], suffix: "LISTEN_EXPOSURE", type: "string" },
  { path: ["runtime", "id"], suffix: "RUNTIME_ID", type: "string" },
  { path: ["runtime", "kind"], suffix: "RUNTIME_KIND", type: "string" },
  { path: ["runtime", "baseUrl"], suffix: "RUNTIME_BASE_URL", type: "string" },
  {
    path: ["runtime", "tokenFile"],
    suffix: "RUNTIME_TOKEN_FILE",
    type: "string",
    appliesWhen: "hermes",
  },
  {
    path: ["runtime", "sessionIdleMs"],
    suffix: "RUNTIME_SESSION_IDLE_MS",
    type: "int",
    appliesWhen: "hermes",
  },
  {
    path: ["runtime", "directory"],
    suffix: "RUNTIME_DIRECTORY",
    type: "string",
    appliesWhen: "opencode",
  },
  {
    path: ["runtime", "username"],
    suffix: "RUNTIME_USERNAME",
    type: "string",
    appliesWhen: "opencode",
  },
  {
    path: ["runtime", "passwordFile"],
    suffix: "RUNTIME_PASSWORD_FILE",
    type: "string",
    appliesWhen: "opencode",
  },
  {
    path: ["runtime", "deviceIdentityFile"],
    suffix: "RUNTIME_DEVICE_IDENTITY_FILE",
    type: "string",
    appliesWhen: "openclaw",
  },
  {
    path: ["runtime", "deviceTokenFile"],
    suffix: "RUNTIME_DEVICE_TOKEN_FILE",
    type: "string",
    appliesWhen: "openclaw",
  },
  {
    path: ["limits", "activeExecutions"],
    suffix: "LIMITS_ACTIVE_EXECUTIONS",
    type: "int",
  },
  {
    path: ["limits", "guestActiveExecutions"],
    suffix: "LIMITS_GUEST_ACTIVE_EXECUTIONS",
    type: "int",
  },
  {
    path: ["limits", "operatorEventPeers"],
    suffix: "LIMITS_OPERATOR_EVENT_PEERS",
    type: "int",
  },
  {
    path: ["limits", "subscriberEvents"],
    suffix: "LIMITS_SUBSCRIBER_EVENTS",
    type: "int",
  },
  {
    path: ["limits", "subscriberBytes"],
    suffix: "LIMITS_SUBSCRIBER_BYTES",
    type: "int",
  },
  {
    path: ["guest", "listen", "host"],
    suffix: "GUEST_LISTEN_HOST",
    type: "string",
    appliesWhen: "guest",
  },
  {
    path: ["guest", "listen", "port"],
    suffix: "GUEST_LISTEN_PORT",
    type: "int",
    appliesWhen: "guest",
  },
  {
    path: ["guest", "listen", "exposure"],
    suffix: "GUEST_LISTEN_EXPOSURE",
    type: "string",
    appliesWhen: "guest",
  },
  {
    path: ["guest", "publicOrigin"],
    suffix: "GUEST_PUBLIC_ORIGIN",
    type: "string",
    appliesWhen: "guest",
  },
  {
    path: ["guest", "invitations", "ttlSeconds"],
    suffix: "GUEST_INVITATIONS_TTL_SECONDS",
    type: "int",
    appliesWhen: "guest",
  },
  {
    path: ["guest", "invitations", "clockSkewSeconds"],
    suffix: "GUEST_INVITATIONS_CLOCK_SKEW_SECONDS",
    type: "int",
    appliesWhen: "guest",
  },
  { path: ["push", "stateDir"], suffix: "PUSH_STATE_DIR", type: "string" },
  {
    path: ["push", "vapid", "subject"],
    suffix: "PUSH_VAPID_SUBJECT",
    type: "string",
  },
  {
    path: ["push", "vapid", "privateKeyFile"],
    suffix: "PUSH_VAPID_PRIVATE_KEY_FILE",
    type: "string",
  },
  {
    path: ["voice", "transcription", "provider"],
    suffix: "VOICE_TRANSCRIPTION_PROVIDER",
    type: "string",
  },
  {
    path: ["voice", "transcription", "baseUrl"],
    suffix: "VOICE_TRANSCRIPTION_BASE_URL",
    type: "string",
  },
  {
    path: ["voice", "transcription", "apiKeyFile"],
    suffix: "VOICE_TRANSCRIPTION_API_KEY_FILE",
    type: "string",
  },
  {
    path: ["voice", "transcription", "model"],
    suffix: "VOICE_TRANSCRIPTION_MODEL",
    type: "string",
  },
  {
    path: ["voice", "transcription", "mode"],
    suffix: "VOICE_TRANSCRIPTION_MODE",
    type: "string",
  },
  {
    path: ["voice", "transcription", "timeoutMs"],
    suffix: "VOICE_TRANSCRIPTION_TIMEOUT_MS",
    type: "int",
  },
  {
    path: ["voice", "transcription", "language"],
    suffix: "VOICE_TRANSCRIPTION_LANGUAGE",
    type: "string",
  },
  {
    path: ["voice", "speech", "provider"],
    suffix: "VOICE_SPEECH_PROVIDER",
    type: "string",
  },
  {
    path: ["voice", "speech", "baseUrl"],
    suffix: "VOICE_SPEECH_BASE_URL",
    type: "string",
  },
  {
    path: ["voice", "speech", "apiKeyFile"],
    suffix: "VOICE_SPEECH_API_KEY_FILE",
    type: "string",
  },
  {
    path: ["voice", "speech", "model"],
    suffix: "VOICE_SPEECH_MODEL",
    type: "string",
  },
  {
    path: ["voice", "speech", "mode"],
    suffix: "VOICE_SPEECH_MODE",
    type: "string",
  },
  {
    path: ["voice", "speech", "timeoutMs"],
    suffix: "VOICE_SPEECH_TIMEOUT_MS",
    type: "int",
  },
  {
    path: ["voice", "speech", "voice"],
    suffix: "VOICE_SPEECH_VOICE",
    type: "string",
  },
  {
    path: ["voice", "speech", "format"],
    suffix: "VOICE_SPEECH_FORMAT",
    type: "string",
  },
  { path: ["shutdownGraceMs"], suffix: "SHUTDOWN_GRACE_MS", type: "int" },
]

/** The environment outranks the file here too, so a row knows its branch. */
function resolveRuntimeKind(
  document: Record<string, unknown>,
  getenv: ProxyEnvReader
): RuntimeKind | undefined {
  const configured =
    trimmed(getenv(`${PROXY_ENV_PREFIX}RUNTIME_KIND`)) ??
    (isRecord(document.runtime) ? document.runtime.kind : undefined)
  return RUNTIME_KINDS.find((kind) => kind === configured)
}

function overrideValue(variable: string, raw: string, type: "string" | "int") {
  if (type === "string") return raw
  // The value may be anything an operator exported, so only the name is quoted.
  if (!/^\d+$/u.test(raw))
    throw new ProxyConfigurationError(
      `${variable} must be a whole number of at least one digit`
    )
  return Number(raw)
}

function assertOverrideApplies(
  override: ProxyEnvOverride,
  variable: string,
  runtimeKind: RuntimeKind | undefined,
  guestConfigured: boolean
) {
  if (override.appliesWhen === undefined) return
  if (override.appliesWhen === "guest") {
    // A stray variable must never open a second listener.
    if (!guestConfigured)
      throw new ProxyConfigurationError(
        `${variable} applies only when the configuration file has a guest block`
      )
    return
  }
  if (override.appliesWhen !== runtimeKind)
    throw new ProxyConfigurationError(
      `${variable} applies only to a ${override.appliesWhen} runtime${
        runtimeKind === undefined
          ? ", and no runtime of that kind is configured"
          : `, and the configured runtime kind is ${runtimeKind}`
      }`
    )
}

/** Writes one leaf, copying each mapping on the way so no input is mutated. */
function setLeaf(
  target: Record<string, unknown>,
  path: string[],
  value: unknown
) {
  let cursor = target
  for (const key of path.slice(0, -1)) {
    const existing = cursor[key]
    const next = isRecord(existing) ? { ...existing } : {}
    cursor[key] = next
    cursor = next
  }
  cursor[path[path.length - 1]!] = value
}

/**
 * Applies the override table, and reports which variable set which field so a
 * validation failure can name it.
 */
function applyEnvOverrides(
  config: Record<string, unknown>,
  getenv: ProxyEnvReader,
  runtimeKind: RuntimeKind | undefined,
  guestConfigured: boolean
) {
  const sources = new Map<string, string>()
  for (const override of PROXY_ENV_OVERRIDES) {
    const variable = `${PROXY_ENV_PREFIX}${override.suffix}`
    const raw = trimmed(getenv(variable))
    if (raw === undefined) continue
    assertOverrideApplies(override, variable, runtimeKind, guestConfigured)
    setLeaf(config, override.path, overrideValue(variable, raw, override.type))
    sources.set(override.path.join("."), variable)
  }
  return sources
}

/** Flattens one issue tree; a union reports through its branches. */
function flattenIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = []
): Array<{ path: string; message: string }> {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path]
    // A discriminated union with no matching `kind` reports no branches at all;
    // its own message names the accepted kinds, so it is reported directly.
    if (issue.code === "invalid_union" && issue.errors.length > 0)
      return issue.errors.flatMap((branch) => flattenIssues(branch, path))
    const joined = path.join(".") || "(document root)"
    // Key text is input too, so an unrecognized key is reported by count.
    return [
      {
        path: joined,
        message:
          issue.code === "unrecognized_keys"
            ? `${issue.keys.length} unrecognized key${issue.keys.length === 1 ? "" : "s"}`
            : issue.message,
      },
    ]
  })
}

function invalidConfiguration(
  location: string,
  issues: readonly z.core.$ZodIssue[],
  sources: Map<string, string>
) {
  const reported = flattenIssues(issues).map(({ path, message }) => {
    const variable = sources.get(path)
    return `  ${path}: ${message}${variable === undefined ? "" : ` (set by ${variable})`}`
  })
  return new ProxyConfigurationError(
    `Invalid proxy configuration in ${location}:\n${[...new Set(reported)].join("\n")}`
  )
}

/**
 * A configuration error is the one start failure an operator must be able to
 * read, and `redactForLog` makes every `Error` opaque. Reporting it as a plain
 * object keeps that invariant for every other failure.
 */
export function describeStartFailure(error: unknown): unknown {
  return error instanceof ProxyConfigurationError
    ? { name: error.name, message: error.message }
    : error
}

export async function loadProxyConfig(
  options: ProxyConfigPathSource & ProxyConfigFileAccess
): Promise<ProxyConfig> {
  const { path, explicit } = resolveProxyConfigPath(options)
  const source = await readConfigFile(path, explicit, options)
  const document = source === undefined ? {} : parseConfigDocument(path, source)
  // The runtime branch resolves first, because it decides which rows apply.
  const runtimeKind = resolveRuntimeKind(document, options.getenv)
  const defaults =
    runtimeKind === "hermes"
      ? deepMerge(DEFAULT_PROXY_CONFIG, {
          runtime: { sessionIdleMs: DEFAULT_HERMES_SESSION_IDLE_MS },
        })
      : DEFAULT_PROXY_CONFIG
  const merged = deepMerge(defaults, document)
  const sources = applyEnvOverrides(
    merged,
    options.getenv,
    runtimeKind,
    document.guest !== undefined
  )
  const result = ProxyConfigSchema.safeParse(merged)
  if (result.success) return result.data
  throw invalidConfiguration(
    source === undefined
      ? `no configuration file; discovered path ${path} was absent`
      : path,
    result.error.issues,
    sources
  )
}
