import { describe, expect, it, vi } from "vitest"

import {
  menuSlashCommands,
  resolveLocalCommand,
  type LocalCommandResult,
} from "@/components/assistant-ui/composer-features"
import { en } from "@/lib/i18n/dictionaries/en"

import {
  buildWorkspaceCommands,
  toLocalCommands,
  toPaletteCommands,
  type WorkspaceCommandInput,
} from "./workspace-commands"

const notices = en.commands.notices
/** A notice's value sits in a bidi isolate, so it reads in either direction. */
const isolated = (value: string) => `\u2068${value}\u2069`
const unmoved = (notice: string) => ({ notice, keepDraft: true })

const MESSAGES = [
  { id: "user-1", role: "user" },
  { id: "answer-1", role: "assistant" },
  { id: "user-2", role: "user" },
  { id: "answer-2", role: "assistant" },
]

/**
 * An idle Session with a conversation, on a runtime that forks, starts turns
 * elsewhere, renames, and offers the model, context, and voice features. Every
 * action is a spy, so a case can say which ones a command called.
 */
function setup(overrides: Partial<WorkspaceCommandInput> = {}) {
  const input: WorkspaceCommandInput = {
    dictionary: en,
    selectedAgentId: "agent-1",
    visibleThreadId: "session-1",
    isThreadEmpty: false,
    isRunning: false,
    hasPendingInteraction: () => false,
    canQueue: true,
    canSteer: true,
    loadedSessions: [
      { sessionId: "session-1", title: "Market brief" },
      { sessionId: "session-2", title: "Pricing" },
    ],
    searchSessions: vi.fn(async () => []),
    openSession: vi.fn(async () => undefined),
    canRename: true,
    renameSession: vi.fn(async () => undefined),
    createSession: vi.fn(async () => undefined),
    createSessionInBackground: vi.fn(async () => ({
      sessionId: "background-1",
    })),
    forkSession: vi.fn(async () => "fork-1"),
    forkSessionInBackground: vi.fn(async () => ({ sessionId: "side-1" })),
    startTurn: vi.fn(async () => undefined),
    reportActionError: vi.fn(),
    cancelRun: vi.fn(),
    childrenRunning: false,
    cancelRunningChildren: vi.fn(),
    messages: () => MESSAGES,
    rewindAvailable: true,
    reloadMessage: vi.fn(),
    beginEdit: vi.fn(),
    copyMessage: vi.fn(async () => undefined),
    queueText: vi.fn(),
    model: {
      options: [
        {
          id: "gpt-5",
          label: "GPT-5",
          efforts: [{ id: "low" }, { id: "high", name: "High" }],
        },
        { id: "sonnet", label: "Claude Sonnet", efforts: [{ id: "medium" }] },
      ],
      selectedId: "sonnet",
      update: vi.fn(async () => undefined),
    },
    contextAvailable: true,
    voiceAvailable: true,
    surface: { request: vi.fn(), subscribe: () => () => undefined },
    ...overrides,
  }
  const commands = buildWorkspaceCommands(input)
  const actions: Record<string, unknown> = {
    ...input,
    "model.update": input.model?.update,
    "surface.request": input.surface.request,
  }
  const localCommands = toLocalCommands(commands)
  return {
    commands,
    localCommands,
    /** Each action a command called, with its calls. */
    calls: () =>
      Object.fromEntries(
        Object.entries(actions).flatMap(([name, action]) =>
          vi.isMockFunction(action) && action.mock.calls.length > 0
            ? [[name, action.mock.calls]]
            : []
        )
      ),
    /** Submits a draft the way the composer does, and returns its answer. */
    type: async (draft: string) => {
      const local = resolveLocalCommand(draft, localCommands)
      expect(local?.outcome).toBe("run")
      return (await local!.command.run(local!.args, local!.flags)) ?? undefined
    },
    /** Whether the `/` menu offers the command a draft names. */
    listed: (draft: string) =>
      resolveLocalCommand(draft, localCommands)?.command.available !== false,
  }
}

describe("workspace commands", () => {
  it.each<readonly [string, Partial<WorkspaceCommandInput>, string]>([
    ["/branch", { isThreadEmpty: true }, notices.emptySession],
    ["/btw what now?", { isThreadEmpty: true }, notices.emptySession],
    [
      "/fork --here",
      { forkSession: undefined, forkSessionInBackground: undefined },
      notices.cannotFork,
    ],
    [
      "/btw",
      { forkSession: undefined, forkSessionInBackground: undefined },
      notices.cannotFork,
    ],
    // Whatever follows the name, the reason answers: no usage first.
    [
      "/btw --side what now?",
      { forkSession: undefined, forkSessionInBackground: undefined },
      notices.cannotFork,
    ],
    ["/btw what now?", { startTurn: undefined }, notices.cannotStartTurn],
    ["/bg draft it", { startTurn: undefined }, notices.cannotStartTurn],
    ["/title Q3", { canRename: false }, notices.cannotRename],
    ["/retry", { isRunning: true }, notices.waitForRun],
    ["/undo", { isRunning: true }, notices.waitForRun],
    ["/copy", { isRunning: true }, notices.waitForRun],
    ["/retry", { isThreadEmpty: true }, notices.emptySession],
    ["/undo", { isThreadEmpty: true }, notices.emptySession],
    ["/copy", { isThreadEmpty: true }, notices.emptySession],
    ["/undo 2", { rewindAvailable: false }, notices.cannotRewind],
    [
      "/steer go left",
      { isRunning: true, canSteer: false },
      notices.cannotSteer,
    ],
    ["/queue later", { isRunning: true, canQueue: false }, notices.waitForRun],
    ["/exit", { visibleThreadId: null }, notices.noSession],
    ["/voice", { voiceAvailable: false }, notices.voiceUnavailable],
    // Neither a turn nor a child Session runs.
    ["/stop", {}, notices.nothingRunning],
  ])(
    "leaves %s out of the menu and answers it in place, keeping the draft and calling nothing",
    async (draft, overrides, notice) => {
      const { type, calls, listed } = setup(overrides)

      expect(listed(draft)).toBe(false)
      expect(await type(draft)).toEqual(unmoved(notice))
      expect(calls()).toEqual({})
    }
  )

  it.each<
    readonly [
      string,
      Partial<WorkspaceCommandInput>,
      Record<string, unknown[][]>,
      LocalCommandResult | undefined,
    ]
  >([
    // The composer hands the text after the name back as the next draft.
    ["/reset plan the launch", {}, { createSession: [["agent-1"]] }, undefined],
    // The opening fork, renamed when named; `--here` means nothing here.
    [
      "/branch --here Pricing ideas",
      {},
      {
        forkSession: [["session-1"]],
        renameSession: [["fork-1", "Pricing ideas"]],
      },
      undefined,
    ],
    ["/fork", { isRunning: true }, { forkSession: [["session-1"]] }, undefined],
    // The staying makers: the Session in view stays in view.
    [
      "/btw why now?",
      {},
      {
        forkSessionInBackground: [["session-1"]],
        startTurn: [["side-1", "why now?"]],
      },
      { notice: notices.startedInBackground },
    ],
    [
      "/bg draft the brief",
      {},
      {
        createSessionInBackground: [["agent-1"]],
        startTurn: [["background-1", "draft the brief"]],
      },
      { notice: notices.startedInBackground },
    ],
    [
      "/title Q3 plan",
      {},
      { renameSession: [["session-1", "Q3 plan"]] },
      undefined,
    ],
    [
      "/stop",
      { isRunning: true, childrenRunning: true },
      { cancelRun: [[]] },
      undefined,
    ],
    [
      "/stop",
      { childrenRunning: true },
      { cancelRunningChildren: [[]] },
      undefined,
    ],
    ["/steer go left", { isRunning: true }, {}, { steer: "go left" }],
    // With no reply to steer, the message is the next turn.
    ["/steer go left", {}, { queueText: [["go left"]] }, undefined],
    [
      "/steer go left",
      { isRunning: true, hasPendingInteraction: () => true },
      {},
      unmoved(notices.answerPending),
    ],
    [
      "/queue /reset",
      { isRunning: true },
      { queueText: [["/reset"]] },
      undefined,
    ],
    ["/retry", {}, { reloadMessage: [["answer-2"]] }, undefined],
    [
      "/retry",
      { hasPendingInteraction: () => true },
      {},
      unmoved(notices.answerPending),
    ],
    ["/undo 2", {}, { beginEdit: [["user-1"]] }, undefined],
    [
      "/copy 2",
      {},
      { copyMessage: [["answer-1"]] },
      { notice: notices.copied },
    ],
    ["/undo 3", {}, {}, unmoved(notices.noSuchMessage)],
    ["/usage", {}, { "surface.request": [["focusContext"]] }, undefined],
    [
      "/help",
      {},
      { "surface.request": [["openKeyboardReference"]] },
      undefined,
    ],
    ["/palette", {}, { "surface.request": [["openPalette"]] }, undefined],
    ["/quit", {}, { "surface.request": [["closeActiveTab"]] }, undefined],
    ["/voice", {}, { "surface.request": [["toggleVoice"]] }, undefined],
  ])(
    "runs %s through its action alone",
    async (draft, overrides, called, result) => {
      const { type, calls } = setup(overrides)

      expect(await type(draft)).toEqual(result)
      expect(calls()).toEqual(called)
    }
  )

  it.each<
    readonly [
      string,
      string,
      readonly { sessionId: string; title: string }[],
      Record<string, unknown[][]>,
      LocalCommandResult | undefined,
    ]
  >([
    [
      "an exact id",
      "session-2",
      [],
      { openSession: [["session-2", "agent-1"]] },
      undefined,
    ],
    [
      "the one title that matches, ignoring case",
      "market BRIEF",
      [],
      { openSession: [["session-1", "agent-1"]] },
      undefined,
    ],
    [
      "the provider's one hit when nothing loaded matches",
      "Roadmap",
      [{ sessionId: "session-9", title: "roadmap" }],
      {
        searchSessions: [["Roadmap", "agent-1"]],
        openSession: [["session-9", "agent-1"]],
      },
      undefined,
    ],
    [
      "an answer when nothing matches",
      "Roadmap",
      [],
      { searchSessions: [["Roadmap", "agent-1"]] },
      unmoved(`No Session matches "${isolated("Roadmap")}".`),
    ],
    [
      "an answer when several match",
      "Roadmap",
      [
        { sessionId: "session-8", title: "Roadmap" },
        { sessionId: "session-9", title: "roadmap" },
      ],
      { searchSessions: [["Roadmap", "agent-1"]] },
      unmoved(
        `Several Sessions match "${isolated("Roadmap")}". Use the Session's id instead.`
      ),
    ],
  ])("resumes %s", async (_, query, hits, called, result) => {
    const { type, calls } = setup({
      searchSessions: vi.fn(async () =>
        hits.map((hit) => ({ ...hit, agentId: "agent-1", updatedAt: "" }))
      ),
    })

    expect(await type(`/resume ${query}`)).toEqual(result)
    expect(calls()).toEqual(called)
  })

  it.each<
    readonly [
      string,
      Record<string, unknown[][]>,
      LocalCommandResult | undefined,
    ]
  >([
    [
      "/model GPT-5",
      { "model.update": [[{ selectedId: "gpt-5" }]] },
      undefined,
    ],
    [
      "/model claude sonnet",
      { "model.update": [[{ selectedId: "sonnet" }]] },
      undefined,
    ],
    [
      "/model --reasoning high gpt-5",
      { "model.update": [[{ selectedId: "gpt-5", effortId: "high" }]] },
      undefined,
    ],
    // Without a name the effort is the shown model's.
    [
      "/model --reasoning medium",
      { "model.update": [[{ effortId: "medium" }]] },
      undefined,
    ],
    [
      "/model --reasoning high",
      {},
      unmoved(`This model has no reasoning effort "${isolated("high")}".`),
    ],
    ["/model llama", {}, unmoved(`No model matches "${isolated("llama")}".`)],
    ["/model", { "surface.request": [["openModel"]] }, undefined],
    [
      "/reasoning MEDIUM",
      { "model.update": [[{ effortId: "medium" }]] },
      undefined,
    ],
    ["/reasoning", { "surface.request": [["openModel"]] }, undefined],
  ])("chooses the model from %s", async (draft, called, result) => {
    const { type, calls } = setup()

    expect(await type(draft)).toEqual(result)
    expect(calls()).toEqual(called)
  })

  it.each<
    readonly [
      string,
      Partial<WorkspaceCommandInput>,
      Record<string, unknown[][]>,
      LocalCommandResult,
    ]
  >([
    [
      "/bg draft the brief",
      {
        startTurn: vi.fn(async () => Promise.reject(new Error("Session busy"))),
      },
      {
        createSessionInBackground: [["agent-1"]],
        startTurn: [["background-1", "draft the brief"]],
      },
      {
        notice: `The new Session could not start: ${isolated("Session busy")}`,
        tone: "error",
        keepDraft: true,
      },
    ],
    ["/btw /reset", {}, {}, unmoved(notices.sidePromptIsCommand)],
    // The gateway strips zero-width padding before it reads a command.
    ["/bg \u200B\u2060/reset", {}, {}, unmoved(notices.sidePromptIsCommand)],
  ])(
    "answers %s about the Session it would start elsewhere",
    async (draft, overrides, called, result) => {
      const { type, calls } = setup(overrides)

      expect(await type(draft)).toEqual(result)
      expect(calls()).toEqual(called)
    }
  )

  it("keeps /new out of the menu on a Session that is already new, yet runs it there", async () => {
    const { type, listed, calls } = setup({ isThreadEmpty: true })

    expect(listed("/new")).toBe(false)
    // Nothing opens; the composer seeds this Session's draft with the text.
    expect(await type("/new plan the launch")).toBeUndefined()
    expect(calls()).toEqual({})
  })

  it("shadows the runtime's namesake with an unavailable command and leaves the rest to it", () => {
    const { commands } = setup({
      forkSession: undefined,
      forkSessionInBackground: undefined,
      model: undefined,
      contextAvailable: false,
    })
    const localCommands = toLocalCommands(commands)
    const menu = menuSlashCommands({
      localCommands,
      slashCommands: [{ name: "fork" }, { name: "model" }, { name: "status" }],
    }).map(({ name }) => name)

    expect(menu).not.toContain("branch")
    expect(menu).not.toContain("fork")
    expect(resolveLocalCommand("/fork", localCommands)?.command.name).toBe(
      "branch"
    )
    expect(menu).toEqual(expect.arrayContaining(["model", "status"]))
    expect(resolveLocalCommand("/model gpt-5", localCommands)).toBeUndefined()
    expect(resolveLocalCommand("/status", localCommands)).toBeUndefined()
  })

  it("offers the palette each command it can run with nothing typed, under its slash spelling", async () => {
    const { commands, calls } = setup({ isRunning: true })
    const palette = toPaletteCommands(commands, undefined)
    const entry = (id: string) => palette.find((command) => command.id === id)

    // Twins carry the built-in action's id, so the palette merges them.
    expect(entry("workspace.newSession")?.slash).toBe("/new")
    expect(entry("keyboard.reference")?.slash).toBe("/help")
    const spellings = palette.map(({ slash }) => slash)
    expect(spellings).not.toContain("/palette")
    expect(spellings).not.toContain("/resume")
    expect(entry("command.retry")).toMatchObject({
      unavailableReason: notices.waitForRun,
      onRun: undefined,
    })

    await entry("command.stop")?.onRun?.()
    expect(calls()).toEqual({ cancelRun: [[]] })
  })

  it("shows a command's palette answer beside the composer", async () => {
    const { commands, calls } = setup({
      copyMessage: vi.fn(async () => Promise.reject(new Error("Denied"))),
    })
    const surface = { request: vi.fn(), subscribe: () => () => undefined }
    const palette = toPaletteCommands(commands, surface)

    await palette.find(({ id }) => id === "command.copy")?.onRun?.()

    expect(calls()).toEqual({ copyMessage: [["answer-2"]] })
    expect(surface.request.mock.calls).toEqual([
      [{ kind: "notice", notice: notices.copyFailed, tone: "error" }],
    ])
  })
})
