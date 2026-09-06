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
  AgentLifecycleEvent,
  AgentSummary,
  RuntimeBundle,
  WorkspaceAdapter,
} from "@/lib/runtime-adapters/contracts"
import { useFixtureRuntimeBundle } from "@/lib/runtime-adapters/fixture/fixture-runtime"
import {
  FIXTURE_NOW,
  type FixtureWorkspace,
  fixtureAgents,
  fixtureSessions,
} from "@/lib/runtime-adapters/fixture/fixture-workspace"

import { FixtureAosUiApp } from "./aos-ui-fixture-app"
import { AosUiWorkspace } from "./aos-ui-workspace"

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
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

describe("reversible local Session tabs", () => {
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
  locale = "en",
}: {
  empty?: boolean
  readOnly?: boolean
  locale?: "en" | "he"
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const workspace = useMemo(
    () =>
      workspaceFacade(fixture.workspace, {
        listAgents: () =>
          empty ? Promise.resolve([]) : fixture.workspace.listAgents(),
        listAgentCatalog: async () =>
          empty
            ? []
            : (await fixture.workspace.listAgentCatalog!()).map((entry) => ({
                ...entry,
                editable: !readOnly,
              })),
        updateAgentVisibility: (id, visibility) =>
          fixture.workspace.updateAgentVisibility!(id, visibility),
        openAgentBuilder: readOnly
          ? undefined
          : (options) => fixture.workspace.openAgentBuilder!(options),
      }),
    [empty, fixture.workspace, readOnly]
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
    ).toBeInTheDocument()
    expect(
      within(main).getByText(
        "Create an Agent with its own role, instructions, and tools."
      )
    ).toBeInTheDocument()
    expect(within(main).getAllByRole("button")).toHaveLength(1)
    await user.click(within(main).getByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent,/ })
  })

  it("keeps provider-managed entries read-only and explains unavailable creation", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture readOnly />)
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    expect(
      (await within(dialog).findAllByText("Managed by provider")).length
    ).toBeGreaterThan(0)
    expect(within(dialog).queryByRole("switch")).toBeNull()
    expect(
      within(dialog).getByRole("button", { name: "New Agent" })
    ).toBeDisabled()
    expect(
      within(dialog).getByText(en.empty.agentBuilderUnavailable)
    ).toBeInTheDocument()
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
        within(main).getByRole("button", { name: dictionary.actions.newAgent })
      ).toBeDisabled()
      expect(
        within(main).getByText(dictionary.empty.agentBuilderUnavailable)
      ).toBeInTheDocument()
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
    ...(workspace.openAgentBuilder
      ? {
          openAgentBuilder: (options) => workspace.openAgentBuilder!(options),
        }
      : {}),
    ...(workspace.deleteAgentDraft
      ? {
          deleteAgentDraft: (agentId: string) =>
            workspace.deleteAgentDraft!(agentId),
        }
      : {}),
    ...(workspace.retryAgentDraft
      ? {
          retryAgentDraft: (agentId: string) =>
            workspace.retryAgentDraft!(agentId),
        }
      : {}),
    ...(workspace.subscribeAgentLifecycle
      ? {
          subscribeAgentLifecycle: (
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeAgentLifecycle"]>
            >[0],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeAgentLifecycle"]>
            >[1]
          ) => workspace.subscribeAgentLifecycle!(listener, onError),
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

type LifecycleOrderingControls = {
  emit: (event: AgentLifecycleEvent) => void
  setCatalog: (agents: AgentSummary[]) => void
}

const reorderedDraft: AgentSummary = {
  kind: "provisional",
  id: "draft:reordered",
  name: "Reordered Agent draft",
  status: "idle",
  builderThreadId: "thread-reordered-builder",
  phase: "interview",
}

class LifecycleCatalog {
  #agents = structuredClone([reorderedDraft, ...fixtureAgents])

  read() {
    return structuredClone(this.#agents)
  }

  replace(agents: AgentSummary[]) {
    this.#agents = structuredClone(agents)
  }
}

function LifecycleOrderingFixture({
  captureControls,
}: {
  captureControls: (controls: LifecycleOrderingControls) => void
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const [providerCatalog] = useState(() => new LifecycleCatalog())
  const bundle = useMemo<RuntimeBundle>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      listAgents: async () => providerCatalog.read(),
      refreshAgents: async () => providerCatalog.read(),
      subscribeAgentLifecycle: (listener) => {
        captureControls({
          emit: listener,
          setCatalog: (agents) => providerCatalog.replace(agents),
        })
        return () => undefined
      },
    })
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [
    captureControls,
    fixture.assistantRuntime,
    fixture.workspace,
    providerCatalog,
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

function ProvisionalStatusFixture({
  phase,
}: {
  phase: "activating" | "activation-failed"
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
      listAgents: async () => [
        {
          kind: "provisional" as const,
          id: "draft:status-test",
          name: "New Agent",
          description: "Being designed with Agent Builder",
          status: "idle" as const,
          icon: {
            kind: "symbol" as const,
            symbol: "unassigned" as const,
            tone: "teal" as const,
          },
          builderThreadId: "thread-builder-status-test",
          phase,
        },
        ...(await fixture.workspace.listAgents()),
      ],
    })
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [fixture.assistantRuntime, fixture.workspace, phase])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      bundle={bundle}
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
        ...(await fixture.workspace.listAgents()),
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
    delete workspace.openAgentBuilder
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
  })

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

  it("shows unavailable Agent Builder controls as disabled capabilities", async () => {
    render(<EmptyAgentFixture />)

    expect(
      await screen.findByRole("button", { name: "New Agent" })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "Manage Agents" })).toBeEnabled()
  })

  it("opens a provisional Agent with only its nonclosable Builder Session", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("button", { name: "New Agent" }))

    const draftAgent = await screen.findByRole("button", {
      name: "New Agent, Status: Needs attention, Selected Agent",
    })
    expect(draftAgent).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "agent-builder" })).toBeNull()
    expect(
      await screen.findByText("Hey, let's build a new agent.")
    ).toBeVisible()
    const tablist = screen.getByRole("tablist", { name: "Sessions" })
    expect(within(tablist).getAllByRole("tab")).toHaveLength(1)
    expect(
      within(tablist).getByRole("tab", { name: "New Agent" })
    ).toHaveAttribute("aria-selected", "true")
    expect(
      screen.queryByRole("button", { name: "Close session: New Agent" })
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull()
    expect(document.querySelector('[data-slot="todo-dock"]')).toBeNull()
  })

  it("uses the active locale for app-created Agent and Session labels", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="he" dictionary={he} />)

    await user.click(await screen.findByRole("button", { name: "סוכן חדש" }))

    expect(
      await screen.findByRole("button", {
        name: "סוכן חדש, מצב: דורש תשומת לב, הסוכן שנבחר",
      })
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole("tablist", { name: "שיחות" })).getByRole("tab", {
        name: "סוכן חדש",
      })
    ).toHaveAttribute("aria-selected", "true")
  })

  it("creates a fresh provisional Agent on every Builder launch", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    const launch = await screen.findByRole("button", { name: "New Agent" })
    await user.click(launch)
    await screen.findByRole("button", {
      name: "New Agent, Status: Needs attention, Selected Agent",
    })
    await user.click(launch)

    await waitFor(() =>
      expect(
        within(screen.getByRole("navigation", { name: "Agents" })).getAllByRole(
          "button",
          { name: /New Agent, Status: Needs attention(?:, Selected Agent)?/ }
        )
      ).toHaveLength(2)
    )
    expect(
      within(screen.getByRole("tablist", { name: "Sessions" })).getAllByRole(
        "tab"
      )
    ).toHaveLength(1)
  })

  it("cancels draft deletion with focus restoration and confirms it explicitly", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    const inspector = await screen.findByRole("complementary", {
      name: "Agent details",
    })
    const deleteTrigger = within(inspector).getByRole("button", {
      name: "Delete Agent draft",
    })

    await user.click(deleteTrigger)
    expect(
      await screen.findByRole("heading", {
        name: "Delete this Agent draft?",
      })
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Keep draft" }))
    await waitFor(() => expect(deleteTrigger).toHaveFocus())
    expect(
      screen.getByRole("button", {
        name: "New Agent, Status: Needs attention, Selected Agent",
      })
    ).toBeInTheDocument()

    await user.click(deleteTrigger)
    await user.click(screen.getByRole("button", { name: "Delete draft" }))

    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /New Agent, Status: Needs attention, Selected Agent/,
        })
      ).toBeNull()
    )
    expect(
      screen.getByRole("button", {
        name: "Aster, Status: Running, Selected Agent",
      })
    ).toHaveFocus()
  })

  it("turns the selected draft into a ready Agent with its first Session", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    const captureWorkspace = (value: FixtureWorkspace) => {
      workspace = value
    }
    render(<BuilderLifecycleFixture captureWorkspace={captureWorkspace} />)

    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    const draft = await screen.findByRole("button", {
      name: "New Agent, Status: Needs attention, Selected Agent",
    })
    const draftId = draft.getAttribute("aria-label")
    expect(draftId).toBe("New Agent, Status: Needs attention, Selected Agent")
    const provisional = (await workspace!.listAgents()).find(
      ({ kind }) => kind === "provisional"
    )
    expect(provisional?.kind).toBe("provisional")

    act(() => {
      workspace!.promoteAgentDraft(provisional!.id, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
        description: "Customer insight",
        icon: { kind: "symbol", symbol: "spark", tone: "teal" },
      })
    })

    expect(
      await screen.findByRole("button", { name: "Sora, Selected Agent" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: /New Agent, Status: Needs attention, Selected Agent/,
      })
    ).toBeNull()
    expect(
      await screen.findByRole("tab", { name: "New session" })
    ).toHaveAttribute("aria-selected", "true")
  })

  it("ignores a delayed draft update older than its deletion tombstone", async () => {
    const user = userEvent.setup()
    let controls: LifecycleOrderingControls | undefined
    render(
      <LifecycleOrderingFixture
        captureControls={(nextControls) => {
          controls = nextControls
        }}
      />
    )
    await user.click(
      await screen.findByRole("button", {
        name: "Reordered Agent draft, Selected Agent",
      })
    )

    await act(async () => {
      controls!.setCatalog(fixtureAgents)
      controls!.emit({
        type: "draft-deleted",
        draftAgentId: "draft:reordered",
        revision: 7,
      })
      await Promise.resolve()
    })
    await screen.findByRole("button", {
      name: "Aster, Status: Running, Selected Agent",
    })

    await act(async () => {
      controls!.setCatalog([
        {
          kind: "provisional",
          id: "draft:reordered",
          name: "Stale Agent draft",
          status: "idle",
          builderThreadId: "thread-stale-builder",
          phase: "interview",
        },
        ...fixtureAgents,
      ])
      controls!.emit({
        type: "draft-updated",
        draftAgentId: "draft:reordered",
        revision: 6,
      })
      await Promise.resolve()
    })

    expect(
      screen.queryByRole("button", { name: /Stale Agent draft/ })
    ).toBeNull()
  })

  it("ignores a delayed promotion older than its deletion tombstone", async () => {
    const user = userEvent.setup()
    let controls: LifecycleOrderingControls | undefined
    render(
      <LifecycleOrderingFixture
        captureControls={(nextControls) => {
          controls = nextControls
        }}
      />
    )
    await user.click(
      await screen.findByRole("button", {
        name: "Reordered Agent draft, Selected Agent",
      })
    )

    await act(async () => {
      controls!.setCatalog(fixtureAgents)
      controls!.emit({
        type: "draft-deleted",
        draftAgentId: "draft:reordered",
        revision: 7,
      })
      await Promise.resolve()
    })
    await screen.findByRole("button", {
      name: "Aster, Status: Running, Selected Agent",
    })

    await act(async () => {
      controls!.setCatalog([
        {
          kind: "ready",
          id: "agent-too-late",
          name: "Late promoted Agent",
          status: "idle",
        },
        ...fixtureAgents,
      ])
      controls!.emit({
        type: "draft-promoted",
        draftAgentId: "draft:reordered",
        agentId: "agent-too-late",
        threadId: "thread-too-late",
        revision: 6,
      })
      await Promise.resolve()
    })

    expect(
      screen.queryByRole("button", { name: /Late promoted Agent/ })
    ).toBeNull()
  })

  it.each([
    { phase: "activating" as const, status: "Running" },
    { phase: "activation-failed" as const, status: "Needs attention" },
  ])(
    "shows $phase drafts as $status in the Agent rail",
    async ({ phase, status }) => {
      render(<ProvisionalStatusFixture phase={phase} />)

      const agentsNavigation = await screen.findByRole("navigation", {
        name: "Agents",
      })
      expect(
        within(agentsNavigation).getByRole("button", {
          name: `New Agent, Status: ${status}, Selected Agent`,
        })
      ).toBeInTheDocument()
    }
  )

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
