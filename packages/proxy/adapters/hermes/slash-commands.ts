import {
  MAX_SLASH_COMMANDS,
  SlashCommandSchema,
  type SlashCommand,
} from "../../../protocol"
import {
  HermesRpcRejectedError,
  HermesUnavailableError,
  type HermesRpcTransport,
} from "./gateway"
import { isRecord } from "./native"

const MAX_CATALOG_RESPONSE_BYTES = 2_097_152
const MAX_COMMAND_RESPONSE_BYTES = 1_048_576

async function nativeCommandPairs(
  transport: HermesRpcTransport,
  params: Readonly<Record<string, unknown>>
) {
  const value = await transport.request("commands.catalog", params, {
    maxResponseBytes: MAX_CATALOG_RESPONSE_BYTES,
  })
  if (
    !value ||
    typeof value !== "object" ||
    !("pairs" in value) ||
    !Array.isArray(value.pairs)
  )
    throw new Error("Invalid Hermes command catalog")
  const canon = "canon" in value ? value.canon : undefined
  if (
    canon !== undefined &&
    (!canon || typeof canon !== "object" || Array.isArray(canon))
  )
    throw new Error("Invalid Hermes command catalog")
  return {
    pairs: value.pairs,
    canon: canon as Readonly<Record<string, unknown>> | undefined,
  }
}

function parsedSlashInvocation(text: string) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text)
  if (!match) return undefined
  return { name: match[1]!, args: match[2]?.trim() ?? "" }
}

export async function nativeSlashCommands(
  transport: HermesRpcTransport,
  params: Readonly<Record<string, unknown>>
): Promise<SlashCommand[]> {
  const { pairs } = await nativeCommandPairs(transport, params)
  const commands: SlashCommand[] = []
  const seen = new Set<string>()
  for (const pair of pairs) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string"
    )
      continue
    const parsed = SlashCommandSchema.safeParse({
      name: pair[0].replace(/^\//u, ""),
      description:
        typeof pair[1] === "string" ? pair[1].slice(0, 4_096) : pair[1],
    })
    if (!parsed.success || seen.has(parsed.data.name)) continue
    seen.add(parsed.data.name)
    commands.push(parsed.data)
    if (commands.length === MAX_SLASH_COMMANDS) break
  }
  return commands
}

export async function nativeSlashInvocation(
  transport: HermesRpcTransport,
  params: Readonly<Record<string, unknown>>,
  text: string
) {
  const invocation = parsedSlashInvocation(text)
  if (!invocation) return undefined
  const { pairs, canon } = await nativeCommandPairs(transport, params)
  const canonicalKey = `/${invocation.name}`.toLowerCase()
  const canonicalValue =
    canon && Object.hasOwn(canon, canonicalKey)
      ? canon[canonicalKey]
      : undefined
  if (canonicalValue !== undefined) {
    const canonical = SlashCommandSchema.safeParse({
      name:
        typeof canonicalValue === "string"
          ? canonicalValue.replace(/^\//u, "")
          : canonicalValue,
    })
    if (!canonical.success) throw new Error("Invalid Hermes command catalog")
    return { ...invocation, name: canonical.data.name }
  }
  const recognized = pairs.find((pair) => {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") return false
    const command = SlashCommandSchema.safeParse({
      name: pair[0].replace(/^\//u, ""),
    })
    return (
      command.success &&
      command.data.name.toLowerCase() === invocation.name.toLowerCase()
    )
  })
  if (!recognized) return undefined
  return { ...invocation, name: recognized[0].replace(/^\//u, "") }
}

/**
 * What one native command execution produced. A `completion` answered the user
 * in band and no native turn follows; an `expanded` execution produced the
 * prompt text the caller submits, which is the only part a refused write may
 * repeat.
 */
export type HermesSlashExecution =
  | { kind: "completion"; output: string; composerPrefill?: string }
  | { kind: "expanded"; text: string }

/**
 * Execute one recognized native command and report what it produced; the
 * expansion is submitted by the caller, so this function performs no
 * `prompt.submit` of its own. `slash.exec` is the current native entry point;
 * `command.dispatch` is attempted only when Hermes states the method is
 * unsupported, and alias traversal is bounded. No dispatched write is ever
 * retried.
 */
export async function executeSlashCommand(
  transport: HermesRpcTransport,
  liveSessionId: string,
  name: string,
  args: string,
  depth = 0
): Promise<HermesSlashExecution> {
  if (depth >= 4) throw new HermesUnavailableError()
  let result: unknown
  try {
    result = await transport.request(
      "slash.exec",
      {
        command: `${name}${args ? ` ${args}` : ""}`,
        session_id: liveSessionId,
      },
      { maxResponseBytes: MAX_COMMAND_RESPONSE_BYTES }
    )
  } catch (error) {
    if (
      !(error instanceof HermesRpcRejectedError) ||
      (error.code !== -32601 && error.code !== 4018)
    )
      throw error
    result = await transport.request(
      "command.dispatch",
      { session_id: liveSessionId, name, arg: args },
      { maxResponseBytes: MAX_COMMAND_RESPONSE_BYTES }
    )
  }
  if (!isRecord(result)) throw new HermesUnavailableError()
  if (result.type === "alias") {
    const target =
      typeof result.target === "string"
        ? /^\/?([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(result.target)
        : undefined
    if (!target) throw new HermesUnavailableError()
    return executeSlashCommand(
      transport,
      liveSessionId,
      target[1]!,
      [target[2], args].filter(Boolean).join(" "),
      depth + 1
    )
  }
  if (result.type === "send" || result.type === "skill") {
    if (typeof result.message !== "string" || !result.message.trim())
      throw new HermesUnavailableError()
    return { kind: "expanded", text: result.message }
  }
  if (result.type === "prefill") {
    if (
      typeof result.message !== "string" ||
      !result.message ||
      Buffer.byteLength(result.message, "utf8") > MAX_COMMAND_RESPONSE_BYTES ||
      (result.notice !== undefined && typeof result.notice !== "string")
    )
      throw new HermesUnavailableError()
    return {
      kind: "completion",
      output: typeof result.notice === "string" ? result.notice : "",
      composerPrefill: result.message,
    }
  }
  if (
    result.type !== "exec" &&
    result.type !== "plugin" &&
    typeof result.output !== "string" &&
    typeof result.warning !== "string"
  )
    throw new HermesUnavailableError()
  return {
    kind: "completion",
    output: [result.warning, result.output]
      .filter((value): value is string => typeof value === "string" && !!value)
      .join("\n"),
  }
}
