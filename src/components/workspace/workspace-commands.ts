import type {
  ComposerFeatureViewModel,
  ComposerLocalCommand,
  ComposerModelOption,
  LocalCommandFlags,
  LocalCommandResult,
} from "@/components/assistant-ui/composer-features"
import type { WorkspaceSurfaceRequests } from "@/components/assistant-ui/surface-requests"
import type { KeyboardCommand } from "@/components/keyboard/command-palette"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { SessionSearchResult } from "@/runtime-adapters/contracts"

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
  readonly knownFlags?: ComposerLocalCommand["knownFlags"]
  readonly available: boolean
  /** Why the entry cannot run now; a typed command reads it in place. */
  readonly unavailableReason?: string | undefined
  /**
   * `false` keeps an entry that still runs out of the `/` menu, as `/new` on a
   * Session that is already new.
   */
  readonly listed?: boolean | undefined
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
  /**
   * Whether the Session waits on the operator's answer, read when a command
   * runs: the composer already follows it as it changes.
   */
  readonly hasPendingInteraction: () => boolean
  /** Whether a message sent during a run waits in the thread's queue. */
  readonly canQueue: boolean
  /** Whether the runtime steers a running reply. */
  readonly canSteer: boolean
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
  /** Asks in a hidden fork of the Session; the tray above the composer answers. */
  readonly askSideQuestion?:
    | ((sessionId: string, question: string) => void)
    | undefined
  /** The workspace's alert for an action that failed. */
  readonly reportActionError: (error: unknown) => void
  readonly cancelRun: () => void
  /** Whether child Sessions of this one still at work stop alone. */
  readonly childrenRunning: boolean
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

/**
 * Whether text reads as a command once the padding the gateway strips before
 * reading one is gone: whitespace and zero-width characters.
 */
const isCommand = (text: string) =>
  text.replace(/^[\s\u200B\u2060\uFEFF]+/u, "").startsWith("/")

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
    Pick<WorkspaceCommandInput, "childrenRunning" | "cancelRunningChildren">
  >

/**
 * `/stop`: the running turn, else the Session's child Sessions still at work.
 * With neither it is unavailable. The guest lane builds it alone, with no
 * children to stop.
 */
export function stopCommand({
  dictionary,
  isRunning,
  cancelRun,
  childrenRunning = false,
  cancelRunningChildren,
}: StopInput): WorkspaceCommand {
  const copy = dictionary.commands
  return entry(
    {
      id: "command.stop",
      names: ["stop"],
      title: copy.stop.title,
      description: copy.stop.description,
      run: async () => {
        if (isRunning) cancelRun()
        else cancelRunningChildren?.()
      },
    },
    blockedBy([isRunning || childrenRunning, copy.notices.nothingRunning])
  )
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
  const conversing = [conversation, notices.emptySession] as const
  // Rewinding replaces the turns after the message, so it waits for the run;
  // a pending request is checked as it runs.
  const rewinding = blockedBy(
    [input.rewindAvailable, notices.cannotRewind],
    conversing,
    [!isRunning, notices.waitForRun]
  )
  const answerPending = unmoved(notices.answerPending)
  // A side prompt goes into a Session nobody watches, so a command typed as
  // one is refused before anything is made, and any failure answers here.
  const startElsewhere = async (
    text: string,
    make: () => Promise<{ readonly sessionId: string }>
  ): Promise<LocalCommandResult | void> => {
    if (!startTurn) return unmoved(notices.cannotStartTurn)
    if (isCommand(text)) return unmoved(notices.sidePromptIsCommand)
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
    // A Session with no conversation is already new: there the command
    // leaves the menu and only seeds its draft with the text after it.
    entry({
      id: "workspace.newSession",
      names: ["new", "reset", "clear"],
      title: dictionary.actions.newSession,
      description: dictionary.actions.newSessionCommand,
      listed: !isThreadEmpty,
      run: async () => {
        if (isThreadEmpty) return
        try {
          await input.createSession(selectedAgentId)
        } catch (error) {
          input.reportActionError(error)
        }
      },
    }),
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
    // `/branch` forks and switches to the fork; `/fork` forks and stays. Each
    // sends the prompt after it, if any, in the fork. Hermes's `--here` has no
    // meaning here and is dropped.
    entry(
      {
        id: "command.branch",
        names: ["branch"],
        title: copy.branch.title,
        description: copy.branch.description,
        argument: { required: false, hint: copy.branch.hint },
        knownFlags: [{ name: "here", takesValue: false }],
        run: async (prompt) => {
          if (!forkSession || !visibleThreadId) return
          if (prompt && !startTurn) return unmoved(notices.cannotStartTurn)
          if (isCommand(prompt)) return unmoved(notices.sidePromptIsCommand)
          // The answer lands after the switch, where the composer drops it,
          // so a failure goes to the workspace's alert.
          try {
            const forked = await forkSession(visibleThreadId)
            if (prompt) await startTurn?.(forked, prompt)
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
        id: "command.fork",
        names: ["fork"],
        title: copy.fork.title,
        description: copy.fork.description,
        argument: { required: false, hint: copy.fork.hint },
        knownFlags: [{ name: "here", takesValue: false }],
        run: async (prompt) => {
          if (!forkSessionInBackground || !visibleThreadId) return
          const fork = () => forkSessionInBackground(visibleThreadId)
          if (prompt) return startElsewhere(prompt, fork)
          try {
            await fork()
            return { notice: notices.forked }
          } catch (error) {
            input.reportActionError(error)
          }
        },
      },
      blockedBy(
        [forkSessionInBackground, notices.cannotFork],
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
          if (!input.askSideQuestion || !visibleThreadId) return
          if (isCommand(question)) return unmoved(notices.sidePromptIsCommand)
          input.askSideQuestion(visibleThreadId, question)
        },
      },
      blockedBy(
        [input.askSideQuestion, notices.cannotFork],
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
    // With no reply running, the message is simply the next turn.
    entry(
      {
        id: "command.steer",
        names: ["steer"],
        title: copy.steer.title,
        description: copy.steer.description,
        argument: { required: true, hint: copy.steer.hint },
        run: async (text) => {
          if (!isRunning) return input.queueText(text)
          if (hasPendingInteraction()) return answerPending
          return { steer: text }
        },
      },
      blockedBy([!isRunning || input.canSteer, notices.cannotSteer])
    ),
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
          if (hasPendingInteraction()) return answerPending
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
          if (hasPendingInteraction()) return answerPending
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
      blockedBy(conversing, [!isRunning, notices.waitForRun])
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
 * so a typed one still shadows the runtime's namesake; it takes its draft as
 * written, so its reason answers whatever follows the name, keeps the draft,
 * and calls nothing.
 */
export function toLocalCommands(
  commands: readonly WorkspaceCommand[]
): ComposerLocalCommand[] {
  return commands.map(
    ({ names: [name, ...aliases], description, ...command }) =>
      command.available
        ? {
            name,
            aliases,
            description,
            argument: command.argument,
            knownFlags: command.knownFlags,
            available: command.listed !== false,
            run: command.run,
          }
        : {
            name,
            aliases,
            description,
            unparsed: true,
            available: false,
            run: async () => unmoved(command.unavailableReason ?? ""),
          }
  )
}

/**
 * The palette's entries, each with its slash spelling beside it. What one
 * answers shows beside the composer, as a typed command's answer does.
 */
export function toPaletteCommands(
  commands: readonly WorkspaceCommand[],
  surface: WorkspaceSurfaceRequests | undefined
): KeyboardCommand[] {
  const answer = (notice: string, tone: "info" | "error") =>
    surface?.request({ kind: "notice", notice, tone })
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
      onRun: command.available
        ? () =>
            command.run("", {}).then(
              (result) => {
                if (result && "notice" in result)
                  answer(result.notice, result.tone ?? "info")
              },
              (error: unknown) => answer(errorText(error), "error")
            )
        : undefined,
    }))
}
