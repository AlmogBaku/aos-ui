import type {
  ComposerFeatureViewModel,
  ComposerLocalCommand,
  ComposerModelOption,
  LocalCommandFlags,
  LocalCommandResult,
} from "@/components/assistant-ui/composer-features"
import type { KeyboardCommand } from "@/components/keyboard/command-palette"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { SessionSearchResult } from "@/runtime-adapters/contracts"

import type { WorkspaceSurfaceRequests } from "./surface-requests"

/**
 * One workspace action under its slash spellings: the composer runs it instead
 * of sending its namesake to the runtime, and the palette offers it.
 */
export type WorkspaceCommand = {
  /** An entry that twins a built-in palette action carries that action's id. */
  readonly id: string
  /** The canonical spelling first, then its aliases. */
  readonly names: readonly [string, ...string[]]
  readonly title: string
  readonly description: string
  readonly argument?: ComposerLocalCommand["argument"]
  /** Text after the command becomes the next draft, as `/new`'s does. */
  readonly acceptsTrailingText?: boolean
  readonly knownFlags?: ComposerLocalCommand["knownFlags"]
  readonly available: boolean
  /** Why the entry cannot run now; a typed command reads it in place. */
  readonly unavailableReason?: string | undefined
  /** The palette cannot take a typed argument, so it offers no such entry. */
  readonly palette: boolean
  readonly run: (
    args: string,
    flags: LocalCommandFlags
  ) => Promise<LocalCommandResult | void>
}

/** A Session a command can name; `agentId` where it may be another Agent's. */
export type CommandSession = {
  readonly sessionId: string
  readonly title: string
  readonly agentId?: string | undefined
}

/** A message `/retry`, `/undo` and `/copy` count back through. */
export type CommandMessage = { readonly id: string; readonly role: string }

/**
 * What the commands act through. Values describe this moment, and the registry
 * is rebuilt when one changes; callbacks are the workspace's own actions. A
 * Session maker that opens what it makes is kept apart from one that leaves
 * the Session in view where it is.
 */
export type WorkspaceCommandInput = {
  readonly dictionary: Dictionary
  readonly selectedAgentId: string
  readonly visibleThreadId: string | null
  readonly isThreadEmpty: boolean
  readonly isRunning: boolean
  readonly hasPendingInteraction: boolean
  /** Whether a message sent during a run waits in the thread's queue. */
  readonly canQueue: boolean
  /** The Agent's Sessions as the workspace lists them, open and older. */
  readonly loadedSessions: readonly CommandSession[]
  readonly searchSessions?:
    | ((
        query: string,
        agentId?: string
      ) => Promise<readonly SessionSearchResult[]>)
    | undefined
  readonly openSession: (
    sessionId: string,
    agentId?: string
  ) => Promise<unknown>
  readonly canRename: boolean
  readonly renameSession: (sessionId: string, title: string) => Promise<unknown>
  /** Opens a new Session of the Agent, as New Session does. */
  readonly createSession: (agentId: string) => Promise<unknown>
  readonly createSessionInBackground: (
    agentId: string
  ) => Promise<{ readonly sessionId: string }>
  /** Forks and opens the fork; resolves with its id. */
  readonly forkSession?: ((sessionId: string) => Promise<string>) | undefined
  readonly forkSessionInBackground?:
    | ((sessionId: string) => Promise<{ readonly sessionId: string }>)
    | undefined
  readonly startTurn?:
    | ((sessionId: string, text: string) => Promise<void>)
    | undefined
  /** The workspace's alert for an action that failed. */
  readonly reportActionError: (error: unknown) => void
  readonly cancelRun: () => void
  /** Child Sessions of this one still at work that stop alone. */
  readonly runningChildren: number
  readonly cancelRunningChildren: () => void
  /** The thread's messages, read when a command runs. */
  readonly messages: () => readonly CommandMessage[]
  readonly rewindAvailable: boolean
  readonly reloadMessage: (messageId: string) => void
  /** Opens a user message's inline editor and brings it into view. */
  readonly beginEdit: (messageId: string) => void
  /** Copies an assistant message's answer; rejects when the copy fails. */
  readonly copyMessage: (messageId: string) => Promise<void>
  /** Sends text as typed, behind a run when one is active. */
  readonly queueText: (text: string) => void
  /** Absent with the selector feature off: `/model` stays the runtime's. */
  readonly model?: ComposerFeatureViewModel["model"]
  /** False with the context feature off: `/context` stays the runtime's. */
  readonly contextAvailable: boolean
  readonly voiceAvailable: boolean
  readonly surface: WorkspaceSurfaceRequests
}

type EntrySpec = Omit<
  WorkspaceCommand,
  "available" | "unavailableReason" | "palette"
> & { readonly palette?: boolean }

/** The first failing check's reason, or none when every check holds. */
function blockedBy(
  ...checks: readonly (readonly [holds: unknown, reason: string])[]
) {
  return checks.find(([holds]) => !holds)?.[1]
}

function entry(spec: EntrySpec, reason?: string): WorkspaceCommand {
  return {
    ...spec,
    palette: spec.palette ?? !spec.argument?.required,
    available: reason === undefined,
    unavailableReason: reason,
  }
}

/** An answer to a command that did nothing: the draft stays to be changed. */
const unmoved = (notice: string): LocalCommandResult => ({
  notice,
  keepDraft: true,
})

/** Fills `{name}`, isolated so the value's direction cannot reorder the line. */
function fill(template: string, name: string, value: string) {
  return template.replace(`{${name}}`, () => `\u2068${value}\u2069`)
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** The items one of whose keys equals `query`, ignoring case. */
function named<T>(
  items: readonly T[],
  query: string,
  keys: (item: T) => readonly (string | undefined)[]
) {
  const wanted = query.toLocaleLowerCase()
  return items.filter((item) =>
    keys(item).some((key) => key?.toLocaleLowerCase() === wanted)
  )
}

/** `/resume`'s rule: an exact id, else the Sessions titled `query`. */
function sessionsNamed<T extends CommandSession>(
  sessions: readonly T[],
  query: string
) {
  const unique = [
    ...new Map(
      sessions.map((session) => [session.sessionId, session])
    ).values(),
  ]
  const byId = unique.filter(({ sessionId }) => sessionId === query)
  return byId.length > 0 ? byId : named(unique, query, ({ title }) => [title])
}

/** The id of the `count`-th last message in `role`; `""` counts as 1. */
function nthLast(
  messages: readonly CommandMessage[],
  role: "user" | "assistant",
  count: string
) {
  if (count && !/^[1-9]\d*$/u.test(count)) return undefined
  return messages
    .filter((message) => message.role === role)
    .at(-Number(count || 1))?.id
}

type StopInput = Pick<
  WorkspaceCommandInput,
  "dictionary" | "isRunning" | "cancelRun"
> &
  Partial<
    Pick<WorkspaceCommandInput, "runningChildren" | "cancelRunningChildren">
  >

/**
 * `/stop`: the running turn, else the Session's child Sessions still at work,
 * else an answer. Text after it becomes the next draft. The guest lane builds
 * it alone, with no children to stop.
 */
export function stopCommand({
  dictionary,
  isRunning,
  cancelRun,
  runningChildren = 0,
  cancelRunningChildren,
}: StopInput): WorkspaceCommand {
  const copy = dictionary.commands
  return entry({
    id: "command.stop",
    names: ["stop"],
    title: copy.stop.title,
    description: copy.stop.description,
    acceptsTrailingText: true,
    run: async (text) => {
      if (isRunning) cancelRun()
      else if (runningChildren > 0 && cancelRunningChildren)
        cancelRunningChildren()
      else return unmoved(copy.notices.nothingRunning)
      return text ? { draft: text } : undefined
    },
  })
}

/** The model the selector shows: the provider's report unless a pick waits. */
function shownModel(model: NonNullable<WorkspaceCommandInput["model"]>) {
  const reported =
    model.selection?.status === "pending" ? undefined : model.follow?.current()
  const selectedId = reported?.selectedId ?? model.selectedId
  return model.options.find(({ id }) => id === selectedId)
}

const effortsNamed = (option: ComposerModelOption | undefined, level: string) =>
  named(option?.efforts ?? [], level, ({ id, name }) => [id, name])

function modelCommands(
  model: NonNullable<WorkspaceCommandInput["model"]>,
  { dictionary, surface }: WorkspaceCommandInput
): WorkspaceCommand[] {
  const copy = dictionary.commands
  const notices = copy.notices
  const noEffort = (level: string) =>
    unmoved(fill(notices.noSuchEffort, "level", level))
  return [
    entry({
      id: "command.model",
      names: ["model"],
      title: copy.model.title,
      description: copy.model.description,
      argument: { required: false, hint: copy.model.hint },
      // Hermes's other `/model` flags have no meaning here, so they stay unknown.
      knownFlags: [{ name: "reasoning", takesValue: true }],
      run: async (query, flags) => {
        const level = typeof flags.reasoning === "string" ? flags.reasoning : ""
        if (!query && !level) {
          surface.request("openModel")
          return
        }
        const chosen = query
          ? named(model.options, query, ({ id, label }) => [id, label])
          : [shownModel(model)]
        if (chosen.length !== 1)
          return unmoved(
            fill(
              chosen.length ? notices.severalModels : notices.noSuchModel,
              "query",
              query
            )
          )
        const efforts = level ? effortsNamed(chosen[0], level) : []
        if (level && efforts.length !== 1) return noEffort(level)
        void model.update({
          ...(query ? { selectedId: chosen[0]?.id } : {}),
          ...(level ? { effortId: efforts[0]?.id } : {}),
        })
      },
    }),
    entry({
      id: "command.reasoning",
      names: ["reasoning"],
      title: copy.reasoning.title,
      description: copy.reasoning.description,
      argument: { required: false, hint: copy.reasoning.hint },
      run: async (level) => {
        if (!level) {
          surface.request("openModel")
          return
        }
        const efforts = effortsNamed(shownModel(model), level)
        if (efforts.length !== 1) return noEffort(level)
        void model.update({ effortId: efforts[0]?.id })
      },
    }),
  ]
}

/**
 * The workspace's slash commands, in menu order. `/model` and `/reasoning` are
 * present only with the selector feature, and `/context` only with the context
 * feature; otherwise the runtime keeps those names.
 */
export function buildWorkspaceCommands(
  input: WorkspaceCommandInput
): readonly WorkspaceCommand[] {
  const {
    dictionary,
    selectedAgentId,
    visibleThreadId,
    isThreadEmpty,
    isRunning,
    hasPendingInteraction,
    forkSession,
    forkSessionInBackground,
    startTurn,
    surface,
    messages,
  } = input
  const copy = dictionary.commands
  const notices = copy.notices
  const conversation = Boolean(visibleThreadId) && !isThreadEmpty
  // Rewinding replaces the turns after the message, so it waits for the run
  // and for the operator's answer to a pending request.
  const rewinding = blockedBy(
    [input.rewindAvailable, notices.cannotRewind],
    [!isRunning, notices.waitForRun],
    [!hasPendingInteraction, notices.answerPending]
  )
  // A side prompt goes into a Session nobody watches, so a command typed as
  // one is refused before anything is made, and any failure answers here.
  const startElsewhere = async (
    text: string,
    make: () => Promise<{ readonly sessionId: string }>
  ): Promise<LocalCommandResult | void> => {
    if (!startTurn) return
    if (text.startsWith("/")) return unmoved(notices.sidePromptIsCommand)
    try {
      const { sessionId } = await make()
      await startTurn(sessionId, text)
      return { notice: notices.startedInBackground }
    } catch (error) {
      return {
        notice: fill(notices.backgroundTurnRefused, "reason", errorText(error)),
        tone: "error",
        keepDraft: true,
      }
    }
  }
  const request =
    (kind: Parameters<WorkspaceSurfaceRequests["request"]>[0]) => async () =>
      surface.request(kind)

  return [
    entry(
      {
        id: "workspace.newSession",
        names: ["new", "reset", "clear"],
        title: dictionary.actions.newSession,
        description: dictionary.actions.newSessionCommand,
        acceptsTrailingText: true,
        run: async (text) => {
          try {
            await input.createSession(selectedAgentId)
          } catch (error) {
            input.reportActionError(error)
            return
          }
          return text ? { draft: text } : undefined
        },
      },
      blockedBy([!isThreadEmpty, notices.alreadyNew])
    ),
    entry({
      id: "command.resume",
      names: ["resume", "sessions"],
      title: copy.resume.title,
      description: copy.resume.description,
      argument: { required: true, hint: copy.resume.hint },
      run: async (query) => {
        try {
          const loaded = sessionsNamed(input.loadedSessions, query)
          const found =
            loaded.length > 0 || !input.searchSessions
              ? loaded
              : sessionsNamed(
                  await input.searchSessions(query, selectedAgentId),
                  query
                )
          const [session] = found
          if (!session || found.length > 1)
            return unmoved(
              fill(
                session ? notices.severalSessionsNamed : notices.noSessionNamed,
                "query",
                query
              )
            )
          await input.openSession(
            session.sessionId,
            session.agentId ?? selectedAgentId
          )
        } catch (error) {
          input.reportActionError(error)
        }
      },
    }),
    // ACP's fork takes no title, so a name after the command renames the fork
    // once it is open. Hermes's `--here` has no meaning here and is dropped.
    entry(
      {
        id: "command.branch",
        names: ["branch", "fork"],
        title: dictionary.actions.forkSession,
        description: dictionary.actions.forkSessionCommand,
        argument: { required: false, hint: copy.branch.hint },
        knownFlags: [{ name: "here", takesValue: false }],
        run: async (name) => {
          if (!forkSession || !visibleThreadId) return
          try {
            const forked = await forkSession(visibleThreadId)
            if (name) await input.renameSession(forked, name)
          } catch (error) {
            input.reportActionError(error)
          }
        },
      },
      blockedBy(
        [forkSession, notices.cannotFork],
        [conversation, notices.emptySession]
      )
    ),
    entry(
      {
        id: "command.btw",
        names: ["btw"],
        title: copy.btw.title,
        description: copy.btw.description,
        argument: { required: true, hint: copy.btw.hint },
        run: async (question) => {
          if (!forkSessionInBackground || !visibleThreadId) return
          return startElsewhere(question, () =>
            forkSessionInBackground(visibleThreadId)
          )
        },
      },
      blockedBy(
        [forkSessionInBackground, notices.cannotFork],
        [startTurn, notices.cannotStartTurn],
        [conversation, notices.emptySession]
      )
    ),
    entry(
      {
        id: "command.bg",
        names: ["bg"],
        title: copy.bg.title,
        description: copy.bg.description,
        argument: { required: true, hint: copy.bg.hint },
        run: (prompt) =>
          startElsewhere(prompt, () =>
            input.createSessionInBackground(selectedAgentId)
          ),
      },
      blockedBy([startTurn, notices.cannotStartTurn])
    ),
    entry(
      {
        id: "command.title",
        names: ["title"],
        title: dictionary.actions.renameSessionTitle,
        description: copy.title.description,
        argument: { required: true, hint: copy.title.hint },
        run: async (title) => {
          if (!visibleThreadId) return
          try {
            await input.renameSession(visibleThreadId, title)
          } catch (error) {
            input.reportActionError(error)
          }
        },
      },
      blockedBy(
        [input.canRename, notices.cannotRename],
        [visibleThreadId, notices.noSession]
      )
    ),
    stopCommand(input),
    entry({
      id: "command.steer",
      names: ["steer"],
      title: copy.steer.title,
      description: copy.steer.description,
      argument: { required: true, hint: copy.steer.hint },
      run: async (text) => ({ steer: text }),
    }),
    entry(
      {
        id: "command.queue",
        names: ["queue"],
        title: copy.queue.title,
        description: copy.queue.description,
        argument: { required: true, hint: copy.queue.hint },
        run: async (text) => input.queueText(text),
      },
      blockedBy([!isRunning || input.canQueue, notices.waitForRun])
    ),
    ...(input.model ? modelCommands(input.model, input) : []),
    entry(
      {
        id: "command.retry",
        names: ["retry"],
        title: copy.retry.title,
        description: copy.retry.description,
        run: async () => {
          const id = nthLast(messages(), "assistant", "")
          if (!id) return unmoved(notices.noSuchMessage)
          input.reloadMessage(id)
        },
      },
      rewinding
    ),
    entry(
      {
        id: "command.undo",
        names: ["undo"],
        title: copy.undo.title,
        description: copy.undo.description,
        argument: { required: false, hint: copy.undo.hint },
        run: async (count) => {
          const id = nthLast(messages(), "user", count)
          if (!id) return unmoved(notices.noSuchMessage)
          input.beginEdit(id)
        },
      },
      rewinding
    ),
    entry(
      {
        id: "command.copy",
        names: ["copy"],
        title: copy.copy.title,
        description: copy.copy.description,
        argument: { required: false, hint: copy.copy.hint },
        run: async (count) => {
          const id = nthLast(messages(), "assistant", count)
          if (!id) return unmoved(notices.noSuchMessage)
          try {
            await input.copyMessage(id)
            return { notice: notices.copied }
          } catch {
            return { notice: notices.copyFailed, tone: "error" }
          }
        },
      },
      blockedBy([!isRunning, notices.waitForRun])
    ),
    ...(input.contextAvailable
      ? [
          entry({
            id: "command.context",
            names: ["context", "status", "usage"],
            title: copy.context.title,
            description: copy.context.description,
            run: request("focusContext"),
          }),
        ]
      : []),
    entry({
      id: "keyboard.reference",
      names: ["help"],
      title: copy.help.title,
      description: copy.help.description,
      run: request("openKeyboardReference"),
    }),
    entry({
      id: "command.palette",
      names: ["palette"],
      title: copy.palette.title,
      description: copy.palette.description,
      palette: false,
      run: request("openPalette"),
    }),
    entry(
      {
        id: "command.quit",
        names: ["quit", "exit"],
        title: dictionary.actions.closeTab,
        description: copy.quit.description,
        run: request("closeActiveTab"),
      },
      blockedBy([visibleThreadId, notices.noSession])
    ),
    entry(
      {
        id: "command.voice",
        names: ["voice"],
        title: copy.voice.title,
        description: copy.voice.description,
        run: request("toggleVoice"),
      },
      blockedBy([input.voiceAvailable, notices.voiceUnavailable])
    ),
  ]
}

/**
 * The composer's local commands. An unavailable entry stays, out of the menu,
 * so a typed one still shadows the runtime's namesake and answers in place
 * with the draft kept; it calls nothing and asks for no argument first.
 */
export function toLocalCommands(
  commands: readonly WorkspaceCommand[]
): ComposerLocalCommand[] {
  return commands.map(
    ({
      names: [name, ...aliases],
      available,
      unavailableReason,
      ...command
    }) => ({
      name,
      aliases,
      description: command.description,
      argument: available ? command.argument : undefined,
      acceptsTrailingText: command.acceptsTrailingText,
      knownFlags: command.knownFlags,
      available,
      run: available
        ? command.run
        : async () => unmoved(unavailableReason ?? ""),
    })
  )
}

/** The palette's entries, each with its slash spelling beside it. */
export function toPaletteCommands(
  commands: readonly WorkspaceCommand[]
): KeyboardCommand[] {
  return commands
    .filter((command) => command.palette)
    .map((command) => ({
      id: command.id,
      title: command.title,
      description: command.description,
      slash: `/${command.names[0]}`,
      unavailableReason: command.available
        ? undefined
        : command.unavailableReason,
      onRun: command.available ? () => command.run("", {}) : undefined,
    }))
}
