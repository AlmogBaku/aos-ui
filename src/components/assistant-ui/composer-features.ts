import type { ComposerUsage } from "./elements/composer-context"

export type ComposerModelOption = {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
  readonly group?: string | undefined
  readonly efforts?:
    | true
    | readonly { readonly id: string; readonly label: string }[]
    | undefined
}

export type ComposerModelSelectionState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly targetId: string }
  | {
      readonly status: "error"
      readonly targetId: string
      readonly error: string
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

  const system = Math.min(used, Math.round((systemTokens / attributed) * used))
  const tools = Math.min(
    used - system,
    Math.round((toolTokens / attributed) * used)
  )
  return { system, tools, messages: used - system - tools, total }
}

export type ComposerFeatureViewModel = {
  /** Undefined hides completion only; execution remains runtime-owned. */
  readonly slashCommands?:
    | readonly { readonly name: string; readonly description?: string }[]
    | undefined
  readonly steer?:
    | ((request: {
        readonly requestId: string
        readonly text: string
      }) => Promise<{ status: "steered" | "queued" }>)
    | undefined
  readonly model?:
    | {
        readonly options: readonly ComposerModelOption[]
        readonly selectedId: string
        /** The in-flight request is separate from the provider-authoritative id. */
        readonly selection?: ComposerModelSelectionState | undefined
        readonly select: (id: string) => Promise<void>
        /** Repeats only the current failed request; stale failures have no retry. */
        readonly retry?: (() => Promise<void>) | undefined
      }
    | undefined
  readonly context?:
    | {
        readonly usage: ComposerUsage
        readonly segments?:
          readonly ("system" | "tools" | "messages")[] | undefined
      }
    | undefined
}
