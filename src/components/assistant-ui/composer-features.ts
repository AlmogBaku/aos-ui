import type { ComposerUsage } from "./elements/composer-context"

export type ComposerModelOption = {
  readonly id: string
  readonly label: string
  readonly group?: string | undefined
}

export function composerUsageFromTokens({
  systemTokens,
  toolTokens,
  messageTokens,
  usedTokens,
  maxTokens,
}: {
  systemTokens: number
  toolTokens: number
  messageTokens: number
  usedTokens: number
  maxTokens: number
}): ComposerUsage {
  const used = Math.round(usedTokens / 1_000)
  const total = Math.round(maxTokens / 1_000)
  const attributed = systemTokens + toolTokens + messageTokens
  if (attributed <= 0) return { system: 0, tools: 0, messages: used, total }

  const system = Math.min(
    used,
    Math.round((systemTokens / attributed) * used)
  )
  const tools = Math.min(
    used - system,
    Math.round((toolTokens / attributed) * used)
  )
  return { system, tools, messages: used - system - tools, total }
}

export type ComposerFeatureViewModel = {
  readonly model?:
    | {
        readonly options: readonly ComposerModelOption[]
        readonly selectedId: string
        readonly select: (id: string) => Promise<void>
      }
    | undefined
  readonly context?:
    | {
        readonly usage: ComposerUsage
        readonly segments?:
          | readonly ("system" | "tools" | "messages")[]
          | undefined
      }
    | undefined
}
