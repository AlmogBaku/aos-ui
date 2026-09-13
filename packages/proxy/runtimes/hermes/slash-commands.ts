import { SlashCommandSchema, type SlashCommand } from "../../../protocol"
import type { HermesRpcTransport } from "./adapter"

export async function nativeSlashCommands(
  transport: HermesRpcTransport,
  params: Readonly<Record<string, unknown>>
): Promise<SlashCommand[]> {
  const value = await transport.request("commands.catalog", params, 2_097_152)
  if (
    !value ||
    typeof value !== "object" ||
    !("pairs" in value) ||
    !Array.isArray(value.pairs)
  )
    return []
  const commands: SlashCommand[] = []
  const seen = new Set<string>()
  for (const pair of value.pairs.slice(0, 10_000)) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string"
    )
      continue
    const parsed = SlashCommandSchema.safeParse({
      name: pair[0].replace(/^\//u, ""),
      description: pair[1],
    })
    if (!parsed.success || seen.has(parsed.data.name)) continue
    seen.add(parsed.data.name)
    commands.push(parsed.data)
    if (commands.length === 256) break
  }
  return commands
}

export function slashInvocation(
  text: string,
  commands: readonly SlashCommand[]
) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text)
  if (!match || !commands.some(({ name }) => name === match[1]))
    return undefined
  return { name: match[1]!, args: match[2]?.trim() ?? "" }
}
