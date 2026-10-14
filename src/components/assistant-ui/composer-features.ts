import type { WorkspaceSurfaceRequests } from "@/components/workspace/surface-requests"
import type {
  ComposerModelFeed,
  ComposerTurnUsage,
} from "@/runtime-adapters/contracts"

import type { ComposerUsage } from "./elements/composer-context"

export type ComposerModelOption = {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
  readonly group?: string | undefined
  /** Provider-reported reasoning efforts; the UI localizes the ladder's ids. */
  readonly efforts?: readonly ComposerModelEffort[] | undefined
}

/** One reasoning effort, with the provider's own name when it reports one. */
export type ComposerModelEffort = {
  readonly id: string
  readonly name?: string | undefined
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

/** The Session's accumulated cost; `currency` is an ISO 4217 code. */
export type ComposerSessionCost = {
  readonly amount: number
  readonly currency: string
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
  /** Other names that run the command; the menu finds it by them too. */
  readonly aliases?: readonly string[] | undefined
}

/** A command's `--name` flags: a value, or `true` for a flag that takes none. */
export type LocalCommandFlags = Readonly<Record<string, string | true>>

/**
 * What a local command hands back to the composer. `notice` shows beside the
 * composer, an answer by default and a failure when `tone` says `"error"`, and
 * `keepDraft` puts back the draft the command consumed unless something was
 * typed since; `draft` becomes the composer's text; `steer` goes into the
 * active turn through the composer's own steering, as the steering shortcut
 * would send it.
 */
export type LocalCommandResult =
  | {
      readonly notice: string
      readonly tone?: "info" | "error" | undefined
      readonly keepDraft?: boolean | undefined
    }
  | { readonly draft: string }
  | { readonly steer: string }

/**
 * A slash command the workspace runs itself instead of sending to the runtime:
 * `/new` opens a Session, which no provider turn can do. `args` is whatever
 * followed the command name and its leading flags, trimmed; empty when the
 * command stood alone.
 */
export type ComposerLocalCommand = ComposerSlashCommand & {
  /** A required argument the draft lacks shows `hint` instead of running. */
  readonly argument?:
    | { readonly required: boolean; readonly hint: string }
    | undefined
  /**
   * The command takes no argument and hands any text after it back as
   * `{ draft }`. Callers read it; the resolver only carries it.
   */
  readonly acceptsTrailingText?: boolean | undefined
  /** `--name` flags the command reads before its argument. */
  readonly knownFlags?:
    | readonly { readonly name: string; readonly takesValue: boolean }[]
    | undefined
  readonly run: (
    args: string,
    flags: LocalCommandFlags
  ) => void | Promise<void | LocalCommandResult>
  /**
   * `false` keeps the command out of the menu while it still shadows the
   * provider's namesake and still runs, so a typed draft never becomes a turn.
   */
  readonly available?: boolean
}

/**
 * How a draft invokes a local command. `missing-argument` and `unknown-flag`
 * leave the command unrun, so the composer can show its usage instead.
 */
export type LocalCommandResolution = {
  readonly command: ComposerLocalCommand
  readonly args: string
  readonly flags: LocalCommandFlags
  readonly outcome: "run" | "missing-argument" | "unknown-flag"
}

/** The first whitespace-separated word of `text` and the trimmed rest. */
function splitWord(text: string): [word: string, rest: string] | undefined {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text)
  return match ? [match[1]!, match[2] ?? ""] : undefined
}

const commandNames = (command: ComposerLocalCommand) =>
  [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase())

/** The local command a draft invokes, by name or alias, case-insensitively. */
export function matchLocalCommand(
  text: string,
  commands: readonly ComposerLocalCommand[] | undefined
): { command: ComposerLocalCommand; args: string } | undefined {
  const draft = text.trim()
  const split = draft.startsWith("/") ? splitWord(draft.slice(1)) : undefined
  if (!split || !commands?.length) return undefined
  const [word, args] = split
  const name = word.toLowerCase()
  const command = commands.find((entry) => commandNames(entry).includes(name))
  return command ? { command, args } : undefined
}

/**
 * Resolves a draft against the local commands. Leading `--name` tokens are the
 * command's flags, read in order; a flag that takes a value takes the next
 * word, and lacking one counts as a missing argument. The first unknown flag
 * stops the command.
 */
export function resolveLocalCommand(
  text: string,
  commands: readonly ComposerLocalCommand[] | undefined
): LocalCommandResolution | undefined {
  const match = matchLocalCommand(text, commands)
  if (!match) return undefined
  const { command } = match
  const flags: Record<string, string | true> = {}
  const resolution = (
    outcome: LocalCommandResolution["outcome"],
    args: string
  ): LocalCommandResolution => ({ command, args, flags, outcome })
  let args = match.args
  for (let token = splitWord(args); token; token = splitWord(args)) {
    const [word, rest] = token
    if (!word.startsWith("--") || word.length === 2) break
    const name = word.slice(2).toLowerCase()
    const flag = command.knownFlags?.find(
      (known) => known.name.toLowerCase() === name
    )
    if (!flag) return resolution("unknown-flag", args)
    args = rest
    if (!flag.takesValue) {
      flags[flag.name] = true
      continue
    }
    const value = splitWord(args)
    if (!value) return resolution("missing-argument", args)
    flags[flag.name] = value[0]
    args = value[1]
  }
  return resolution(
    command.argument?.required && !args ? "missing-argument" : "run",
    args
  )
}

/** Local commands lead the completion menu and shadow a provider's namesake. */
export function menuSlashCommands(
  features: Pick<ComposerFeatureViewModel, "slashCommands" | "localCommands">
): readonly ComposerSlashCommand[] {
  const local = features.localCommands ?? []
  const shadowed = new Set(local.flatMap(commandNames))
  return [
    ...local
      .filter((command) => command.available !== false)
      .map(({ name, description, aliases }) => ({
        name,
        description,
        aliases,
      })),
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
        /**
         * The provider's own reports of the Session's model. While no write is
         * pending, its newest reading wins over `selectedId` and `effortId`.
         */
        readonly follow?: ComposerModelFeed | undefined
      }
    | undefined
  readonly context?:
    | {
        readonly usage: ComposerUsage
        readonly segments?:
          | readonly ("system" | "tools" | "messages")[]
          | undefined
        readonly lastTurn?: ComposerTurnUsage | undefined
        readonly cost?: ComposerSessionCost | undefined
      }
    | undefined
  /** Requests from outside the composer to open its model or context surface. */
  readonly surface?: WorkspaceSurfaceRequests | undefined
}
