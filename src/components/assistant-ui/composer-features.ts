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

export type ComposerSlashCommand = {
  readonly name: string
  readonly description?: string | undefined
}

/**
 * A slash command the workspace runs itself instead of sending to the runtime:
 * `/new` opens a Session, which no provider turn can do. `args` is whatever
 * followed the command name, trimmed; empty when the command stood alone.
 */
export type ComposerLocalCommand = ComposerSlashCommand & {
  readonly run: (args: string) => void | Promise<void>
  /**
   * `false` keeps the command out of the menu while it still shadows the
   * provider's namesake and still runs, so a typed draft never becomes a turn.
   */
  readonly available?: boolean
}

const LOCAL_COMMAND = /^\/(\S+)(?:\s+([\s\S]*))?$/u

/** The local command a draft invokes, by name, case-insensitively. */
export function matchLocalCommand(
  text: string,
  commands: readonly ComposerLocalCommand[] | undefined
): { command: ComposerLocalCommand; args: string } | undefined {
  const match = LOCAL_COMMAND.exec(text.trim())
  if (!match || !commands?.length) return undefined
  const name = match[1]!.toLowerCase()
  const command = commands.find((entry) => entry.name.toLowerCase() === name)
  return command ? { command, args: match[2]?.trim() ?? "" } : undefined
}

/** Local commands lead the completion menu and shadow a provider's namesake. */
export function menuSlashCommands(
  features: Pick<ComposerFeatureViewModel, "slashCommands" | "localCommands">
): readonly ComposerSlashCommand[] {
  const local = features.localCommands ?? []
  const shadowed = new Set(local.map((command) => command.name.toLowerCase()))
  return [
    ...local
      .filter((command) => command.available !== false)
      .map(({ name, description }) => ({ name, description })),
    ...(features.slashCommands ?? []).filter(
      (command) => !shadowed.has(command.name.toLowerCase())
    ),
  ]
}

export type ComposerFeatureViewModel = {
  /** Undefined hides completion only; execution remains runtime-owned. */
  readonly slashCommands?: readonly ComposerSlashCommand[] | undefined
  /** Commands the UI runs itself; a submitted one never reaches the runtime. */
  readonly localCommands?: readonly ComposerLocalCommand[] | undefined
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
