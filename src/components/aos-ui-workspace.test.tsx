import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useEffect, useMemo, useState } from "react"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type {
  RuntimeBundle,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import {
  FixtureThreadListAdapter,
  useFixtureRuntimeBundle,
} from "@/runtime-adapters/fixture/fixture-runtime"
import {
  FIXTURE_NOW,
  type FixtureWorkspace,
  fixtureSessions,
} from "@/runtime-adapters/fixture/fixture-workspace"

import { FixtureAosUiApp } from "@/runtime-adapters/fixture/composition"
import { AosUiWorkspace } from "./aos-ui-workspace"

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: window.location.pathname }),
  useNavigate: () => (href: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"](
      null,
      "",
      href
    )
  },
}))

beforeEach(() => window.history.replaceState({}, "", "/"))
afterEach(cleanup)

function TabFixture({ capture }: { capture: (bundle: RuntimeBundle) => void }) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const bundle = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  useEffect(() => capture(bundle), [bundle, capture])
  return (
    <AosUiWorkspace
      bundle={bundle}
      locale="en"
      dictionary={en}
      now={FIXTURE_NOW}
    />
  )
}

function CreatorFixtureAosUiApp({ locale }: { locale: "en" | "he" }) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const bundle = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
    enableAgentCreator: true,
  })
  return (
    <AosUiWorkspace
      bundle={bundle}
      locale={locale}
      dictionary={locale === "he" ? he : en}
      now={FIXTURE_NOW}
    />
  )
}

describe("reversible local Session tabs", () => {
  it("applies browser navigation while a previous Session switch is finishing", async () => {
    const user = userEvent.setup()
    let bundle: RuntimeBundle | undefined
    const capture = (value: RuntimeBundle) => {
      bundle = value
    }
    const view = render(<TabFixture capture={capture} />)
    await screen.findByRole("tab", { name: "Market brief" })
    const threads = bundle!.assistantRuntime.threads
    const switchToThread = threads.switchToThread.bind(threads)
    const pending = deferred<void>()
    vi.spyOn(threads, "switchToThread").mockImplementation(async (id) => {
      await switchToThread(id)
      if (id === "thread-mica-quarterly") await pending.promise
    })

    try {
      await user.click(screen.getByRole("button", { name: "Mica" }))
      await screen.findByRole("tab", { name: "Quarterly synthesis" })
      // The router exposes Back before the previous adapter promise settles.
      window.history.replaceState({}, "", "/agent-aster/thread-aster-market")
      view.rerender(<TabFixture capture={capture} />)
      await waitFor(() =>
        expect(
          screen.getByRole("tab", { name: "Market brief" })
        ).toHaveAttribute("aria-selected", "true")
      )
    } finally {
      await act(async () => pending.resolve())
    }
    expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(window.location.pathname).toBe("/agent-aster/thread-aster-market")
  }, 20_000)

  it("keeps the resolved conversation mounted during a background Session reload", async () => {
    let bundle: RuntimeBundle | undefined
    render(
      <TabFixture
        capture={(value) => {
          bundle = value
        }}
      />
    )
    await screen.findByText(/Enterprise AI spend continues/)

    const pendingList =
      deferred<Awaited<ReturnType<FixtureThreadListAdapter["list"]>>>()
    const list = vi
      .spyOn(FixtureThreadListAdapter.prototype, "list")
      .mockReturnValueOnce(pendingList.promise)

    let reload!: Promise<void>
    act(() => {
      reload = bundle!.assistantRuntime.threads.reload()
    })
    await waitFor(() => expect(list).toHaveBeenCalledOnce())

    expect(screen.queryByText("Loading workspace…")).toBeNull()
    expect(screen.getByText(/Enterprise AI spend continues/)).toBeVisible()

    pendingList.resolve({ threads: [] })
    await act(() => reload)
    list.mockRestore()
  })

  it("opens an older Session encoded in a direct URL", async () => {
    window.history.replaceState({}, "", "/agent-aster/thread-aster-pricing")

    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    expect(
      await screen.findByRole("tab", { name: "Pricing analysis" })
    ).toHaveAttribute("aria-selected", "true")
    expect(window.location.pathname).toBe("/agent-aster/thread-aster-pricing")
  })

  it("normalizes a stale route to an available Agent and Session", async () => {
    window.history.replaceState({}, "", "/missing-agent/missing-session")
    const replaceState = vi.spyOn(window.history, "replaceState")

    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("tab", { name: "Market brief" })
    await waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(
        null,
        "",
        "/agent-aster/thread-aster-market"
      )
    )
  })

  it("leaves no selected Session after the last open tab closes, even with older history", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)
    await screen.findByRole("tab", { name: "Market brief" })
    for (const title of ["Market brief", "Launch review", "Competitive scan"]) {
      await user.click(
        screen.getByRole("button", { name: `Close session: ${title}` })
      )
    }
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0))
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Competitive scan" })
      ).toHaveAttribute("aria-selected", "true")
    )
  })
  it("restores the exact closed tab and selection without provider lifecycle mutations", async () => {
    const user = userEvent.setup()
    let bundle: RuntimeBundle | undefined
    render(
      <TabFixture
        capture={(value) => {
          bundle = value
        }}
      />
    )
    await screen.findByRole("tab", { name: "Market brief" })
    const runtime = bundle!.assistantRuntime
    const item = runtime.threads.getItemById("thread-aster-market")
    const archive = vi.spyOn(item, "archive")
    const remove = vi.spyOn(item, "delete")
    const stop = vi.spyOn(runtime.thread, "cancelRun")
    const create = vi.spyOn(bundle!.workspace, "createSession")
    const before = await bundle!.workspace.getSessionMetadata([
      "thread-aster-market",
    ])
    await user.click(
      screen.getByRole("button", { name: "Close session: Market brief" })
    )
    expect(screen.queryByRole("tab", { name: "Market brief" })).toBeNull()
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    )
    expect(
      await bundle!.workspace.getSessionMetadata(["thread-aster-market"])
    ).toEqual(before)
    for (const mutation of [archive, remove, stop, create])
      expect(mutation).not.toHaveBeenCalled()
  })

  it("Undo restores a background tab without selecting it", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)
    await screen.findByRole("tab", { name: "Market brief" })
    await user.click(
      screen.getByRole("button", { name: "Close session: Launch review" })
    )
    expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    expect(screen.getByRole("tab", { name: "Launch review" })).toHaveAttribute(
      "aria-selected",
      "false"
    )
    expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })
})

function CatalogFixture({
  empty = false,
  readOnly = false,
  creatorInCatalog = false,
  creatorFirst = false,
  creatorOnly = false,
  agentGate,
  locale = "en",
}: {
  empty?: boolean
  readOnly?: boolean
  creatorInCatalog?: boolean
  creatorFirst?: boolean
  creatorOnly?: boolean
  agentGate?: Promise<void>
  locale?: "en" | "he"
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const agentCreator = fixture.workspace.agentCreator!
  const workspace = useMemo(
    () =>
      workspaceFacade(fixture.workspace, {
        listAgents: async () => {
          await agentGate
          if (empty) return []
          const agents = (await fixture.workspace.listAgents()).filter(
            (agent) => !readOnly || agent.role !== "creator"
          )
          if (creatorOnly) {
            return agents.filter(({ id }) => id === agentCreator.id)
          }
          return creatorFirst
            ? [
                ...agents.filter(({ id }) => id === agentCreator.id),
                ...agents.filter(({ id }) => id !== agentCreator.id),
              ]
            : agents
        },
        listAgentCatalog: async () => {
          if (empty) return []
          const entries = (await fixture.workspace.listAgentCatalog!()).map(
            (entry) => ({ ...entry, editable: !readOnly })
          )
          return creatorInCatalog
            ? [
                ...entries,
                {
                  summary: agentCreator,
                  visibility: "visible" as const,
                  selectable: true,
                  editable: !readOnly,
                },
              ]
            : entries
        },
        updateAgentVisibility: (id, visibility) =>
          fixture.workspace.updateAgentVisibility!(id, visibility),
      }),
    [
      creatorFirst,
      creatorInCatalog,
      creatorOnly,
      agentGate,
      agentCreator,
      empty,
      fixture.workspace,
      readOnly,
    ]
  )
  return (
    <AosUiWorkspace
      bundle={{ assistantRuntime: fixture.assistantRuntime, workspace }}
      locale={locale}
      dictionary={locale === "he" ? he : en}
      now={FIXTURE_NOW}
    />
  )
}

describe("Agent management", () => {
  it("defaults to an ordinary Agent when the creator is listed first", async () => {
    render(<CatalogFixture creatorFirst />)

    expect(
      await screen.findByRole("button", { name: /^Aster,/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("resolves an explicit creator route when no ordinary Agents exist", async () => {
    window.history.replaceState({}, "", "/agent-builder")
    render(<CatalogFixture creatorOnly />)

    expect(
      within(
        await screen.findByRole("main", { name: "Conversation" })
      ).getByText("Agent Creator")
    ).toBeVisible()
  })

  it("waits for a delayed catalog before resolving a creator route", async () => {
    const agentGate = deferred<void>()
    window.history.replaceState({}, "", "/agent-builder")
    render(<CatalogFixture creatorOnly agentGate={agentGate.promise} />)

    await act(
      () => new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    )
    await act(async () => agentGate.resolve())

    expect(
      await within(
        screen.getByRole("main", { name: "Conversation" })
      ).findByText("Agent Creator")
    ).toBeVisible()
  })

  it("keeps the creator out of Agent management catalogs", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture creatorInCatalog />)

    await user.click(
      await screen.findByRole("button", { name: "Manage Agents" })
    )
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    expect(within(dialog).queryByText("Agent Creator")).toBeNull()
  })

  it("shows hidden Agents and reconciles hiding the selected and last visible Agent", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture />)
    await screen.findByRole("button", { name: /^Aster,/ })
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    const switches = await within(dialog).findAllByRole("switch")
    expect(
      switches.some((item) => item.getAttribute("aria-checked") === "false")
    ).toBe(true)
    await user.click(
      within(dialog).getByRole("switch", { name: "Show in workspace: Aster" })
    )
    await user.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Mica,/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )
    expect(screen.queryByRole("button", { name: /^Aster,/ })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const reopened = await screen.findByRole("dialog", {
      name: "Manage Agents",
    })
    for (const toggle of await within(reopened).findAllByRole("switch", {
      checked: true,
    })) {
      await user.click(toggle)
      await waitFor(() =>
        expect(toggle).toHaveAttribute("aria-checked", "false")
      )
    }
    await user.keyboard("{Escape}")
    const main = screen.getByRole("main", { name: "Conversation" })
    expect(
      within(main).getByRole("heading", {
        name: "Add an Agent to your workspace.",
      })
    ).toBeVisible()
    expect(within(main).queryByText("Agent Creator")).toBeNull()
    expect(
      within(main).getByRole("button", { name: "New Agent" })
    ).toBeVisible()
  }, 10_000) // Sequential catalog mutations exercise the full workspace.

  it("keeps provider-managed entries read-only and omits unavailable creation", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture readOnly />)
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    expect(
      (await within(dialog).findAllByText("Managed by provider")).length
    ).toBeGreaterThan(0)
    expect(within(dialog).queryByRole("switch")).toBeNull()
    expect(
      within(dialog).queryByRole("button", { name: "New Agent" })
    ).toBeNull()
  })

  it.each(["en", "he"] as const)(
    "renders a truly empty roster in %s and retains management",
    async (locale) => {
      const user = userEvent.setup()
      const dictionary = locale === "he" ? he : en
      render(<CatalogFixture empty readOnly locale={locale} />)
      const heading =
        locale === "en"
          ? "Add an Agent to your workspace."
          : "הוסיפו סוכן לסביבת העבודה."
      await screen.findByRole("heading", { name: heading })
      const main = screen.getByRole("main", {
        name: dictionary.workspace.conversation,
      })
      expect(
        within(main).queryByRole("button", {
          name: dictionary.actions.newAgent,
        })
      ).toBeNull()
      await user.click(
        screen.getByRole("button", { name: dictionary.workspace.manageAgents })
      )
      const dialog = await screen.findByRole("dialog", {
        name: dictionary.workspace.manageAgents,
      })
      expect(dialog).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr")
      await user.keyboard("{Escape}")
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: dictionary.workspace.manageAgents,
          })
        ).toHaveFocus()
      )
    }
  )
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function workspaceFacade(
  workspace: WorkspaceAdapter,
  overrides: Partial<WorkspaceAdapter> = {}
): WorkspaceAdapter {
  return {
    listAgents: () => workspace.listAgents(),
    refreshAgents: () => workspace.refreshAgents(),
    getSessionMetadata: (threadIds) => workspace.getSessionMetadata(threadIds),
    createSession: (agentId, options) =>
      workspace.createSession(agentId, options),
    ...(workspace.subscribeTodos
      ? {
          subscribeTodos: (
            threadId: string,
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeTodos"]>
            >[1],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeTodos"]>
            >[2]
          ) => workspace.subscribeTodos!(threadId, listener, onError),
        }
      : {}),
    ...(workspace.subscribeAgentCatalog
      ? {
          subscribeAgentCatalog: (
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeAgentCatalog"]>
            >[0],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeAgentCatalog"]>
            >[1]
          ) => workspace.subscribeAgentCatalog!(listener, onError),
        }
      : {}),
    ...(workspace.subscribeSessionMetadata
      ? {
          subscribeSessionMetadata: (
            threadIds: readonly string[],
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
            >[1],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
            >[2]
          ) =>
            workspace.subscribeSessionMetadata!(threadIds, listener, onError),
        }
      : {}),
    ...overrides,
  }
}

function BuilderSignalFixture({
  captureCatalogEvent,
}: {
  captureCatalogEvent: (event: {
    complete: () => void
    fail: (error: Error) => void
  }) => void
}) {
  const [providerState] = useState(() => ({ completed: false }))
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const bundle = useMemo<RuntimeBundle>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      refreshAgents: async () => [
        ...(await fixture.workspace.listAgents()),
        ...(providerState.completed
          ? [
              {
                kind: "ready" as const,
                id: "agent-sora",
                name: "Sora",
                description: "Customer insight",
                status: "idle" as const,
                icon: {
                  kind: "symbol" as const,
                  symbol: "spark" as const,
                  tone: "teal" as const,
                },
              },
            ]
          : []),
      ],
      subscribeAgentCatalog: (listener, onError) => {
        captureCatalogEvent({
          complete: () => {
            providerState.completed = true
            listener()
          },
          fail: (error) => onError?.(error),
        })
        return () => undefined
      },
    })
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [
    captureCatalogEvent,
    fixture.assistantRuntime,
    fixture.workspace,
    providerState,
  ])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      bundle={bundle}
      now={FIXTURE_NOW}
    />
  )
}

function BuilderLifecycleFixture({
  captureWorkspace,
}: {
  captureWorkspace: (workspace: FixtureWorkspace) => void
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })

  useEffect(() => {
    captureWorkspace(fixture.workspace)
  }, [captureWorkspace, fixture.workspace])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      bundle={fixture}
      now={FIXTURE_NOW}
    />
  )
}

function EmptyAgentFixture({
  createSession,
}: {
  createSession?: WorkspaceAdapter["createSession"]
} = {}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const bundle = useMemo<RuntimeBundle>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      listAgents: async () => [
        ...(await fixture.workspace.listAgents()).filter(
          (agent) => agent.role !== "creator"
        ),
        {
          kind: "ready" as const,
          id: "agent-empty",
          name: "Empty",
          description: "A new Agent without Sessions",
          status: "idle",
        },
      ],
      ...(createSession ? { createSession } : {}),
    })
    workspace.refreshAgents = workspace.listAgents
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [createSession, fixture.assistantRuntime, fixture.workspace])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      bundle={bundle}
      now={FIXTURE_NOW}
    />
  )
}

function StaleTodoFixture({
  captureStaleEmission,
}: {
  captureStaleEmission: (emit: () => void) => void
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const bundle = useMemo<RuntimeBundle>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      subscribeTodos: (subscribedThreadId, listener) => {
        if (subscribedThreadId === "thread-aster-market") {
          listener([{ id: "old", label: "Old Agent task", status: "active" }])
          captureStaleEmission(() =>
            listener([
              { id: "late", label: "Leaked delayed task", status: "failed" },
            ])
          )
        } else {
          listener([])
        }
        // Deliberately misbehave like a provider that delivers a queued event
        // after unsubscription. The surface must still isolate the old Session.
        return () => undefined
      },
    })
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [captureStaleEmission, fixture.assistantRuntime, fixture.workspace])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      bundle={bundle}
      now={FIXTURE_NOW}
    />
  )
}

function SessionMetadataSignalFixture({
  captureSignal,
  initialMetadata,
}: {
  captureSignal: (signal: {
    publish: (
      metadata: Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>
    ) => void
    fail: (error: Error) => void
  }) => void
  initialMetadata?: Promise<
    Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>
  >
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const bundle = useMemo<RuntimeBundle>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      ...(initialMetadata ? { getSessionMetadata: () => initialMetadata } : {}),
      subscribeSessionMetadata: (_threadIds, listener, onError) => {
        captureSignal({
          publish: listener,
          fail: (error) => onError?.(error),
        })
        return () => undefined
      },
    })
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [
    captureSignal,
    fixture.assistantRuntime,
    fixture.workspace,
    initialMetadata,
  ])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      bundle={bundle}
      now={FIXTURE_NOW}
    />
  )
}

function ClockBoundaryFixture({ readNow }: { readNow: () => Date }) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      bundle={fixture}
      now={readNow()}
      readNow={readNow}
    />
  )
}

describe("AosUiApp fixture composition", () => {
  it("routes Activity to its owning Agent and Session while suppressing exact focused selection", async () => {
    const user = userEvent.setup()
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true)
    let provider: FixtureWorkspace | undefined
    function ActivityFixture() {
      const [threadId, setThreadId] = useState<string | undefined>(
        "thread-aster-market"
      )
      const bundle = useFixtureRuntimeBundle({
        threadId,
        onThreadIdChange: setThreadId,
      })
      useEffect(() => {
        provider = bundle.workspace
      }, [bundle.workspace])
      return (
        <AosUiWorkspace
          bundle={bundle}
          locale="en"
          dictionary={en}
          now={FIXTURE_NOW}
          readNow={() => FIXTURE_NOW}
        />
      )
    }
    try {
      render(<ActivityFixture />)
      await screen.findByRole("tab", { name: "Market brief" })
      act(() => provider!.publishActivityScenario("run-completed"))
      await user.click(
        screen.getAllByRole("button", { name: "Activity, 0 unread" })[0]!
      )
      expect(await screen.findByText("A turn finished")).toBeVisible()
      await user.keyboard("{Escape}")
      act(() => provider!.publishActivityScenario("delayed-non-selected"))
      const bell = (
        await screen.findAllByRole("button", { name: "Activity, 1 unread" })
      )[0]!
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
      await user.click(bell)
      await user.click(screen.getByRole("button", { name: /Open: Mica,/ }))
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      expect(
        screen.getByRole("button", { name: /Mica.*Selected Agent/ })
      ).toBeVisible()
      expect(
        screen.getByRole("tab", { name: "Quarterly synthesis" })
      ).toHaveAttribute("aria-selected", "true")
      expect(
        screen.getAllByRole("button", { name: "Activity, 0 unread" })
      ).toHaveLength(2)
    } finally {
      focus.mockRestore()
    }
  }, 20_000)

  it("removes an idle Session tab when it reaches the exact 12-hour boundary", async () => {
    vi.useFakeTimers()
    let clock = new Date("2026-09-03T18:59:59.000Z")

    try {
      render(<ClockBoundaryFixture readNow={() => clock} />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(
        screen.getByRole("tab", { name: "Launch review" })
      ).toBeInTheDocument()

      clock = new Date("2026-09-03T19:00:00.000Z")
      await act(() => vi.advanceTimersByTimeAsync(1_000))

      expect(
        screen.queryByRole("tab", { name: "Launch review" })
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole("tab", { name: "Market brief" })
      ).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("joins provider Agents, Session tabs, the thread, and explicit todos", async () => {
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    const tablist = await screen.findByRole("tablist", { name: "Sessions" })
    expect(
      await within(tablist).findByRole("tab", { name: "Market brief" })
    ).toHaveAttribute("aria-selected", "true")
    expect(
      await screen.findByText(
        "Enterprise AI spend continues to broaden and deepen."
      )
    ).toBeInTheDocument()
    expect(screen.getAllByText("Demo workspace")).toHaveLength(2)
    expect(screen.getByRole("heading", { name: "Outputs" })).toBeVisible()
    expect(screen.getAllByText("enterprise-ai-brief.md")).toHaveLength(2)
    expect(screen.getAllByText("quarterly-spend.csv")).toHaveLength(2)
    expect(screen.getAllByText("market-summary.html")).toHaveLength(2)

    const message = screen
      .getByText("Plan")
      .closest('[data-slot="aui_assistant-message-content"]')
    const dock = document.querySelector<HTMLElement>('[data-slot="todo-dock"]')
    expect(message).toContainElement(screen.getByText("Plan"))
    expect(dock).not.toBeNull()
    expect(message).not.toContainElement(dock)
    expect(within(dock!).getByText("Session todos.")).toBeInTheDocument()
    expect(
      within(dock!).getByText("1 of 5 session tasks complete")
    ).toBeInTheDocument()
    expect(
      message?.parentElement?.querySelector(
        '[data-agent-symbol="spark"][data-tone="indigo"]'
      )
    ).not.toBeNull()
  })

  it("hides the Todo dock for a Session with no provider Todos", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("tab", { name: "Launch review" }))

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Launch review" })
      ).toHaveAttribute("aria-selected", "true")
    )

    expect(document.querySelector('[data-slot="todo-dock"]')).toBeNull()
  })

  it("localizes Session-scoped Todo copy in Hebrew", async () => {
    render(<FixtureAosUiApp locale="he" dictionary={he} />)

    const dock = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-slot="todo-dock"]'
      )
      expect(element).not.toBeNull()
      return element!
    })

    expect(within(dock).getByText("משימות השיחה")).toBeInTheDocument()
    expect(
      within(dock).getByText("1 מתוך 5 משימות בשיחה הושלמו")
    ).toBeInTheDocument()
  })

  it("restores the last valid Session when switching Agents", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("tab", { name: "Market brief" })
    await user.click(screen.getByRole("button", { name: "Mica" }))
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Quarterly synthesis" })
      ).toHaveAttribute("aria-selected", "true")
    )

    await user.click(
      screen.getByRole("button", { name: "Aster, Status: Running" })
    )
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    )
  })

  it("opens an older Session from Agent history and keeps it as a tab", async () => {
    const user = userEvent.setup()
    const pushState = vi.spyOn(window.history, "pushState")
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    const historySession = await screen.findByRole("button", {
      name: "Open session: Pricing analysis",
    })
    await user.click(historySession)

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Pricing analysis" })
      ).toHaveAttribute("aria-selected", "true")
    )
    expect(pushState).toHaveBeenCalledWith(
      null,
      "",
      "/agent-aster/thread-aster-pricing"
    )
    expect(
      screen.getByRole("button", { name: "Close session: Market brief" })
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Close session: Pricing analysis" })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Pricing analysis" })
      ).not.toBeInTheDocument()
    )
  })

  it("closes an automatically recent Session tab until history reopens it", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("tab", { name: "Market brief" })
    await user.click(
      screen.getByRole("button", { name: "Close session: Market brief" })
    )

    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Market brief" })
      ).not.toBeInTheDocument()
    )

    await user.click(
      screen.getByRole("button", {
        name: "Open session: Market brief, Status: Running",
      })
    )
    expect(
      await screen.findByRole("tab", { name: "Market brief" })
    ).toHaveAttribute("aria-selected", "true")
  })

  it("shows the fallback history Session as a tab for an Agent with only old history", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("button", { name: "Vela" }))

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Activation metrics" })
      ).toHaveAttribute("aria-selected", "true")
    )
  })

  it("allows the sole fallback history tab to be closed", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("button", { name: "Vela" }))
    await screen.findByRole("tab", { name: "Activation metrics" })

    await user.click(
      screen.getByRole("button", {
        name: "Close session: Activation metrics",
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Activation metrics" })
      ).not.toBeInTheDocument()
    )
  })

  it("never exposes another Agent's conversation when the selected Agent has no Session", async () => {
    const user = userEvent.setup()
    render(<EmptyAgentFixture />)

    await screen.findByText(
      "Enterprise AI spend continues to broaden and deepen."
    )
    await user.click(screen.getByRole("button", { name: "Empty" }))

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Enterprise AI spend continues to broaden and deepen."
        )
      ).not.toBeInTheDocument()
    )
    expect(screen.getByText(en.empty.conversationTitle)).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "Message input" })).toBeNull()
    expect(document.querySelector('[data-slot="todo-dock"]')).toBeNull()
  })

  it("exposes one session-creation action when the selected Agent has no Sessions", async () => {
    const user = userEvent.setup()
    render(<EmptyAgentFixture />)

    await user.click(await screen.findByRole("button", { name: "Empty" }))

    expect(
      await screen.findAllByRole("button", { name: en.actions.newSession })
    ).toHaveLength(1)
  })

  it("identifies the selected Agent in the empty conversation launch state", async () => {
    const user = userEvent.setup()
    render(<EmptyAgentFixture />)

    await user.click(await screen.findByRole("button", { name: "Empty" }))

    expect(
      within(
        screen.getByRole("main", { name: en.workspace.conversation })
      ).getByText("Empty")
    ).toBeVisible()
  })

  it("omits Agent Builder controls when creation is unavailable", async () => {
    render(<EmptyAgentFixture />)

    await screen.findByRole("button", { name: "Manage Agents" })
    expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull()
  })

  it("does not expose Agent creation in the public fixture demo", async () => {
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("button", { name: /^Aster,/ })
    expect(screen.queryByText("Agent Creator")).toBeNull()
    expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull()
  })

  it("keeps the creator out of ordinary Agent navigation", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("button", { name: /^Aster,/ })
    expect(screen.queryByRole("button", { name: /^Agent Creator,/ })).toBeNull()

    await user.click(screen.getByRole("button", { name: /^Commands \(/ }))
    expect(
      screen.queryByRole("button", { name: "Select Agent: Agent Creator" })
    ).toBeNull()
  })

  it("opens an ordinary closable creator Session and sends one interview kickoff", async () => {
    const startedAt = performance.now()
    const user = userEvent.setup()
    render(<CreatorFixtureAosUiApp locale="en" />)
    console.info("creator:render", performance.now() - startedAt)
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    console.info("creator:click", performance.now() - startedAt)
    expect(await screen.findByText("Let's create a new Agent.")).toBeVisible()
    console.info("creator:prompt", performance.now() - startedAt)
    expect(
      await screen.findByRole("button", { name: "Close session: New Agent" })
    ).toBeEnabled()
    console.info("creator:close", performance.now() - startedAt)
    expect(window.location.pathname).toContain("agent-builder")
    expect(screen.queryByRole("button", { name: /^Agent Creator,/ })).toBeNull()
    expect(screen.queryByText("Delete Agent draft")).toBeNull()
  })

  it("uses the active locale for the creator Session and interview prompt", async () => {
    const user = userEvent.setup()
    render(<CreatorFixtureAosUiApp locale="he" />)
    await user.click(await screen.findByRole("button", { name: "סוכן חדש" }))
    expect(await screen.findByText("בוא ניצור סוכן חדש.")).toBeVisible()
    expect(screen.getByRole("tab", { name: "סוכן חדש" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })

  it("keeps the interview selected when a usable Agent is discovered, without creating its first Session", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    const captureWorkspace = (value: FixtureWorkspace) => {
      workspace = value
    }
    render(<BuilderLifecycleFixture captureWorkspace={captureWorkspace} />)
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByText("Let's create a new Agent.")
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    const path = window.location.pathname
    await act(async () =>
      workspace!.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )
    expect(await screen.findByRole("button", { name: "Sora" })).toBeVisible()
    expect(window.location.pathname).toBe(path)
    expect(
      workspace!
        .listAllSessionMetadata()
        .filter(({ agentId }) => agentId === "agent-sora")
    ).toHaveLength(0)
    expect(
      (await workspace!.getSessionMetadata([creatorSession.threadId]))[0]
        .agentId
    ).toBe("agent-builder")
  })

  it("refreshes the Agent catalog only after provider-signaled Builder completion", async () => {
    const user = userEvent.setup()
    let completeBuilder: () => void = () => undefined
    render(
      <BuilderSignalFixture
        captureCatalogEvent={(event) => {
          completeBuilder = event.complete
        }}
      />
    )

    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("tab", { name: "New Agent" })
    expect(screen.queryByRole("button", { name: "Sora" })).toBeNull()

    await act(async () => completeBuilder())

    expect(
      await screen.findByRole("button", { name: "Sora" })
    ).toBeInTheDocument()
  })

  it("surfaces provider errors from Agent catalog completion signals", async () => {
    let failCatalog: (error: Error) => void = () => undefined
    render(
      <BuilderSignalFixture
        captureCatalogEvent={(event) => {
          failCatalog = event.fail
        }}
      />
    )

    await screen.findAllByText("Aster")
    act(() => failCatalog(new Error("Agent catalog signal failed")))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent catalog signal failed"
    )
    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-slot",
      "error-toast"
    )
  })

  it("surfaces new-Session failures from the empty state", async () => {
    const user = userEvent.setup()
    render(
      <EmptyAgentFixture
        createSession={async () => {
          throw new Error("Provider rejected the Session")
        }}
      />
    )

    await screen.findByText(
      "Enterprise AI spend continues to broaden and deepen."
    )
    await user.click(screen.getByRole("button", { name: "Empty" }))
    await user.click(
      (
        await screen.findAllByRole("button", {
          name: en.actions.newSession,
        })
      ).find((button) => button.textContent === en.actions.newSession)!
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider rejected the Session"
    )
  })

  it("ignores delayed todo events from the previously visible Session", async () => {
    const user = userEvent.setup()
    let emitStale: () => void = () => undefined
    const captureStaleEmission = (emit: () => void) => {
      emitStale = emit
    }
    render(<StaleTodoFixture captureStaleEmission={captureStaleEmission} />)

    await user.click(await screen.findByText("Session todos."))
    expect(await screen.findByText("Old Agent task")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Mica" }))
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Quarterly synthesis" })
      ).toHaveAttribute("aria-selected", "true")
    )
    emitStale()

    expect(screen.queryByText("Old Agent task")).not.toBeInTheDocument()
    expect(screen.queryByText("Leaked delayed task")).not.toBeInTheDocument()
  })

  it("updates old Session tab eligibility from authoritative metadata signals", async () => {
    let publishMetadata: (
      metadata: Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>
    ) => void = () => undefined
    const captureSignal = (signal: {
      publish: typeof publishMetadata
      fail: (error: Error) => void
    }) => {
      publishMetadata = signal.publish
    }
    render(<SessionMetadataSignalFixture captureSignal={captureSignal} />)

    await screen.findByRole("tab", { name: "Market brief" })
    expect(
      screen.queryByRole("tab", { name: "Pricing analysis" })
    ).not.toBeInTheDocument()

    const waiting = fixtureSessions.map((session) =>
      session.threadId === "thread-aster-pricing"
        ? { ...session, status: "waiting-for-input" as const }
        : session
    )
    act(() => publishMetadata(waiting))
    expect(
      await screen.findByRole("tab", { name: "Pricing analysis" })
    ).toBeInTheDocument()

    act(() => publishMetadata(fixtureSessions))
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Pricing analysis" })
      ).not.toBeInTheDocument()
    )
  })

  it("does not let an initial metadata fetch overwrite a newer signal", async () => {
    const initial =
      deferred<Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>>()
    let subscribed = false
    let publishMetadata: (
      metadata: Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>
    ) => void = () => undefined
    render(
      <SessionMetadataSignalFixture
        initialMetadata={initial.promise}
        captureSignal={(signal) => {
          subscribed = true
          publishMetadata = signal.publish
        }}
      />
    )
    await waitFor(() => expect(subscribed).toBe(true))

    const waiting = fixtureSessions.map((session) =>
      session.threadId === "thread-aster-pricing"
        ? { ...session, status: "waiting-for-input" as const }
        : session
    )
    act(() => publishMetadata(waiting))
    expect(
      await screen.findByRole("tab", { name: "Pricing analysis" })
    ).toBeInTheDocument()

    await act(async () => initial.resolve(fixtureSessions))
    expect(
      screen.getByRole("tab", { name: "Pricing analysis" })
    ).toBeInTheDocument()
  })
})
