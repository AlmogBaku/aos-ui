import type { ComposerUsage } from "./elements/composer-context"

export type ComposerModelOption = {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
  readonly group?: string | undefined
  /** Provider-reported reasoning effort ids; the UI localizes their labels. */
  readonly efforts?: readonly string[] | undefined
}

/** A partial model change: the model, its reasoning effort, or both. */
export type ComposerModelUpdate = {
  readonly selectedId?: string | undefined
  readonly effortId?: string | undefined
}

export type ComposerModelSelectionState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly target: ComposerModelUpdate }
  | {
      readonly status: "error"
      readonly target: ComposerModelUpdate
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
        /** The displayed model: the in-flight target while a write is pending. */
        readonly selectedId: string
        /** The displayed reasoning effort; absent = provider default. */
        readonly effortId?: string | undefined
        readonly selection?: ComposerModelSelectionState | undefined
        readonly update: (patch: ComposerModelUpdate) => Promise<void>
        /** Repeats only the failed patch; a settled selection has no retry. */
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
