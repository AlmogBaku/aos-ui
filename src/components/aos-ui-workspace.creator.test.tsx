import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"

import { type WorkspaceFixtureRuntime } from "./test-utils/controlled-workspace-fixture"
import {
  CreatorFixtureAosUiApp,
  interviewWorkspace,
  PendingInterviewFixture,
  deferred,
  GatedMetadataCreatorFixture,
  BuilderSignalFixture,
  type CreatedAgentHandle,
  CreatedAgentFixture,
  BuilderLifecycleFixture,
  FIXTURE_NOW,
  FixtureAosUiApp,
  type FixtureWorkspace,
} from "./aos-ui-workspace.test-helpers"

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

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  window.localStorage.clear()
})
afterEach(cleanup)

describe("AosUiApp fixture composition", () => {
  it("does not expose Agent creation in the public fixture demo, nor the creator in Agent navigation or Commands", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("button", { name: /^Aster,/ })
    expect(screen.getByRole("button", { name: "Manage Agents" })).toBeVisible()
    expect(screen.queryByText("Agent Creator")).toBeNull()
    expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Agent Creator,/ })).toBeNull()

    await user.click(screen.getByRole("button", { name: /^Commands \(/ }))
    expect(
      screen.queryByRole("button", { name: "Select Agent: Agent Creator" })
    ).toBeNull()
  })

  it("opens the interview as its own New Agent draft", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <CreatorFixtureAosUiApp
        locale="en"
        capture={(bundle) => {
          workspace = bundle.workspace
        }}
      />
    )

    await user.click(await screen.findByRole("button", { name: "New Agent" }))

    expect(await screen.findByText("Let's create a new Agent.")).toBeVisible()
    const draftRow = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    expect(draftRow).toHaveAttribute("aria-current", "true")
    const interview = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    expect(window.location.pathname).toBe(
      `/draft%3A${interview.threadId}/${interview.threadId}`
    )
    expect(screen.queryByRole("button", { name: /^Agent Creator/ })).toBeNull()

    await user.click(screen.getByRole("button", { name: /^Commands \(/ }))
    expect(
      screen.getByRole("button", { name: "Select Agent: New Agent" })
    ).toBeVisible()
  })

  it("opens New Agent as a pending draft before its Session exists", async () => {
    const user = userEvent.setup()
    const firstTurn = deferred<void>()
    let workspace: FixtureWorkspace | undefined
    render(
      <PendingInterviewFixture
        firstTurn={firstTurn.promise}
        capture={(value) => {
          workspace = value
        }}
      />
    )
    await screen.findByRole("button", { name: /^Aster,/ })

    await user.click(screen.getByRole("button", { name: "New Agent" }))

    const draftRow = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    expect(draftRow).toHaveAttribute("aria-current", "true")
    expect(window.location.pathname).toBe("/draft-pending")
    expect(await screen.findByText(en.creator.kickoff)).toBeVisible()
    expect(screen.queryByRole("tablist", { name: "Sessions" })).toBeNull()
    expect(
      screen.queryByRole("complementary", { name: en.workspace.agentDetails })
    ).toBeNull()
    expect(
      workspace!.listAllSessionMetadata().map(({ agentId }) => agentId)
    ).toEqual(["agent-aster"])

    await user.click(draftRow)

    expect(screen.getByText(en.creator.kickoff)).toBeVisible()
    expect(window.location.pathname).toBe("/draft-pending")

    await act(async () => firstTurn.resolve())

    const interview = await waitFor(() => {
      const created = workspace!
        .listAllSessionMetadata()
        .find(({ agentId }) => agentId === "agent-builder")
      expect(created).toBeDefined()
      return created!
    })
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/draft%3A${interview.threadId}/${interview.threadId}`
      )
    )
    expect(
      screen.getByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("discards a pending draft deleting no Session, and a started draft by deleting its interview Session", async () => {
    const user = userEvent.setup()
    const discardDraft = async () => {
      fireEvent.contextMenu(
        await screen.findByRole("button", { name: /^New Agent, draft/ }),
        { clientX: 16, clientY: 24 }
      )
      await user.click(
        await screen.findByRole("menuitem", { name: en.actions.discardDraft })
      )
    }
    const expectDraftRetired = async () => {
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /^New Agent, draft/ })
        ).toBeNull()
      )
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
          "aria-current",
          "true"
        )
      )
    }
    const firstTurn = deferred<void>()
    let pending: FixtureWorkspace | undefined
    render(
      <PendingInterviewFixture
        firstTurn={firstTurn.promise}
        capture={(value) => {
          pending = value
        }}
      />
    )
    await screen.findByRole("button", { name: /^Aster,/ })
    await user.click(screen.getByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const before = pending!.listAllSessionMetadata()

    await discardDraft()

    await expectDraftRetired()
    expect(pending!.listAllSessionMetadata()).toEqual(before)
    expect(screen.queryByRole("alert")).toBeNull()

    cleanup()
    let bundle:
      | {
          workspace: FixtureWorkspace
          assistantRuntime: WorkspaceFixtureRuntime["assistantRuntime"]
        }
      | undefined
    render(
      <CreatorFixtureAosUiApp
        locale="en"
        capture={(value) => {
          bundle = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const interview = bundle!.workspace
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await discardDraft()
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: en.actions.discardDraft,
      })
    )

    await expectDraftRetired()
    const threads = bundle!.assistantRuntime.threads.getState()
    expect(
      threads.threadIds.map((id) => threads.threadItems[id]?.remoteId)
    ).not.toContain(interview.threadId)
  })

  it("localizes Session-scoped Todo copy, the interview draft, and its prompt in Hebrew", async () => {
    const user = userEvent.setup()
    render(<CreatorFixtureAosUiApp locale="he" />)

    const dock = await screen.findByRole("region", {
      name: "משימות השיחה",
    })
    expect(within(dock).getByText("משימות השיחה")).toBeInTheDocument()
    expect(
      within(dock).getByText("3 מתוך 5 משימות בשיחה הושלמו")
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "סוכן חדש" }))

    expect(await screen.findByText("בוא ניצור סוכן חדש.")).toBeVisible()
    expect(
      await screen.findByRole("button", { name: /^סוכן חדש, טיוטה/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("rebuilds an unresolved draft from provider Sessions after a reload", async () => {
    const workspace = interviewWorkspace(0)
    render(<CreatorFixtureAosUiApp locale="en" workspace={workspace} />)
    await screen.findByRole("button", { name: /^New Agent, draft/ })

    cleanup()
    render(<CreatorFixtureAosUiApp locale="en" workspace={workspace} />)

    expect(
      await screen.findByRole("button", { name: /^New Agent, draft/ })
    ).toBeVisible()
  })

  it("hides an interview older than the draft window", async () => {
    render(
      <CreatorFixtureAosUiApp
        locale="en"
        workspace={interviewWorkspace(48 * 60 * 60 * 1000)}
      />
    )

    await screen.findByRole("button", { name: /^Aster/ })
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
  })

  it("never treats a draft as the default Agent", async () => {
    render(
      <CreatorFixtureAosUiApp locale="en" workspace={interviewWorkspace(0)} />
    )

    expect(
      await screen.findByRole("button", { name: /^Aster/ })
    ).toHaveAttribute("aria-current", "true")
    expect(
      await screen.findByRole("button", { name: /^New Agent, draft/ })
    ).not.toHaveAttribute("aria-current", "true")
  })

  it("keeps a selected draft selected while Session metadata refreshes", async () => {
    const user = userEvent.setup()
    const workspace = interviewWorkspace(0)
    const refresh = deferred<void>()
    let holding = false
    const hold = async () => {
      if (holding) await refresh.promise
    }
    let runtime: WorkspaceFixtureRuntime["assistantRuntime"] | undefined
    render(
      <GatedMetadataCreatorFixture
        workspace={workspace}
        hold={hold}
        capture={(value) => {
          runtime = value
        }}
      />
    )
    await user.click(
      await screen.findByRole("button", { name: /^New Agent, draft/ })
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^New Agent, draft/ })
      ).toHaveAttribute("aria-current", "true")
    )

    holding = true
    await act(async () => {
      await workspace.createSession("agent-mica", { title: "Later" })
      await runtime!.threads.reload()
    })

    expect(
      screen.getByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: /^Aster/ })).not.toHaveAttribute(
      "aria-current",
      "true"
    )

    holding = false
    await act(async () => refresh.resolve())
    expect(
      await screen.findByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("replaces a resolved draft with the created Agent and creates it no Session", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <BuilderLifecycleFixture
        captureWorkspace={(value) => {
          workspace = value
        }}
      />
    )
    await screen.findByRole("button", { name: /^Aster,/ })
    const createSession = vi.spyOn(workspace!, "createSession")
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    const interview = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    expect(interview).toHaveAttribute("aria-current", "true")
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await act(async () =>
      workspace!.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Sora/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(
      workspace!
        .listAllSessionMetadata()
        .filter(({ agentId }) => agentId === "agent-sora")
    ).toHaveLength(0)
    expect(screen.getByRole("tablist", { name: "Sessions" })).toBeVisible()
    expect(
      screen.getByRole("button", { name: en.actions.hideAgentDetails })
    ).toBeVisible()
  })

  it("never steals selection from the Agent in the foreground", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <BuilderLifecycleFixture
        captureWorkspace={(value) => {
          workspace = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    await user.click(screen.getByRole("button", { name: /^Aster,/ }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )

    await act(async () =>
      workspace!.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )

    expect(
      await screen.findByRole("button", { name: /^Sora/ })
    ).not.toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
  })

  it("waits for the catalog to list the created Agent before resolving the draft", async () => {
    const user = userEvent.setup()
    let handle: CreatedAgentHandle | undefined
    render(
      <CreatedAgentFixture
        hideFor={1}
        capture={(value) => {
          handle = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = handle!.workspace
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await act(async () =>
      handle!.workspace.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )

    expect(
      await screen.findByRole("button", { name: /^Sora/ })
    ).toHaveAttribute("aria-current", "true")
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
    expect(screen.queryByText(en.creator.createdPending)).toBeNull()
  })

  it("keeps the draft and reports the created Agent as pending when the catalog never lists it", async () => {
    const user = userEvent.setup()
    let handle: CreatedAgentHandle | undefined
    render(
      <CreatedAgentFixture
        hideFor={Number.MAX_SAFE_INTEGER}
        capture={(value) => {
          handle = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = handle!.workspace
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await act(async () =>
      handle!.workspace.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )

    expect(await screen.findByText(en.creator.createdPending)).toBeVisible()
    expect(
      screen.getByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
    expect(screen.queryByRole("button", { name: "Sora" })).toBeNull()
  })

  it("reports a failed catalog refresh and keeps the draft it cannot resolve", async () => {
    const user = userEvent.setup()
    let handle: CreatedAgentHandle | undefined
    render(
      <CreatedAgentFixture
        capture={(value) => {
          handle = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = handle!.workspace
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    handle!.failNextRefresh()

    await act(async () =>
      handle!.emitActivity({
        id: "created-2",
        type: "agent-ready",
        agentId: "agent-sora",
        threadId: creatorSession.threadId,
        occurredAt: FIXTURE_NOW.toISOString(),
      })
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent catalog refresh failed"
    )
    expect(
      screen.getByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("retires the draft and explains an Agent that still needs operator setup", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <BuilderLifecycleFixture
        captureWorkspace={(value) => {
          workspace = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await act(async () =>
      workspace!.failAgentSetup(creatorSession.threadId, "agent-sora", "Sora")
    )

    expect(await screen.findByText(en.creator.createdHidden)).toBeVisible()
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^New Agent, draft/ })
      ).toBeNull()
    )
    expect(screen.queryByRole("button", { name: "Sora" })).toBeNull()
    await waitFor(() =>
      expect(window.location.pathname).not.toContain("draft%3A")
    )
  })

  it("ignores a created Agent reported from a Session the creator does not own", async () => {
    let handle: CreatedAgentHandle | undefined
    render(
      <CreatedAgentFixture
        capture={(value) => {
          handle = value
        }}
      />
    )
    await screen.findByRole("button", { name: /^Aster,/ })
    const before = handle!.refreshCalls()

    await act(async () =>
      handle!.emitActivity({
        id: "created-1",
        type: "agent-ready",
        agentId: "agent-sora",
        threadId: "thread-aster-market",
        occurredAt: FIXTURE_NOW.toISOString(),
      })
    )

    expect(handle!.refreshCalls()).toBe(before)
    expect(screen.queryByText(en.creator.createdPending)).toBeNull()
    expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
      "aria-current",
      "true"
    )
  })

  it("shows no draft after a reload of an interview that already created its Agent", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <BuilderLifecycleFixture
        captureWorkspace={(value) => {
          workspace = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    await act(async () =>
      workspace!.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^New Agent, draft/ })
      ).toBeNull()
    )

    cleanup()
    window.history.replaceState({}, "", "/")
    render(
      <CreatorFixtureAosUiApp
        locale="en"
        workspace={workspace}
        initialThreadId={creatorSession.threadId}
      />
    )

    await screen.findByRole("button", { name: /^Sora/ })
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
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
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    expect(screen.queryByRole("button", { name: "Sora" })).toBeNull()

    await act(async () => completeBuilder())

    expect(
      await screen.findByRole("button", { name: /^Sora/ })
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
})
