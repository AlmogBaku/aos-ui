import { SlashCommandSchema, type SlashCommand } from "../../../protocol"
import type { HermesRpcTransport } from "./adapter"

const MAX_CATALOG_RESPONSE_BYTES = 2_097_152

async function nativeCommandPairs(
  transport: HermesRpcTransport,
  params: Readonly<Record<string, unknown>>
) {
  const value = await transport.request(
    "commands.catalog",
    params,
    MAX_CATALOG_RESPONSE_BYTES
  )
  if (
    !value ||
    typeof value !== "object" ||
    !("pairs" in value) ||
    !Array.isArray(value.pairs)
  )
    throw new Error("Invalid Hermes command catalog")
  return value.pairs
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
  const pairs = await nativeCommandPairs(transport, params)
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
    if (commands.length === 256) break
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
  const pairs = await nativeCommandPairs(transport, params)
  const recognized = pairs.some((pair) => {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") return false
    const command = SlashCommandSchema.safeParse({
      name: pair[0].replace(/^\//u, ""),
    })
    return command.success && command.data.name === invocation.name
  })
  return recognized ? invocation : undefined
}

export function slashInvocation(
  text: string,
  commands: readonly SlashCommand[]
) {
  const invocation = parsedSlashInvocation(text)
  if (!invocation || !commands.some(({ name }) => name === invocation.name))
    return undefined
  return invocation
}
