import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"

import { createSurfaceRequests } from "@/components/workspace/surface-requests"
import type { WorkspaceCommand } from "@/components/workspace/workspace-commands"
import {
  WorkspaceShell,
  type WorkspaceAgent,
  type WorkspaceSession,
  type WorkspaceShellProps,
} from "@/components/workspace/workspace-shell"

vi.mock("next-themes", () => ({
  useTheme: () => ({ setTheme: vi.fn(), theme: "system" }),
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const agents: WorkspaceAgent[] = [
  { id: "one", name: "One", status: "idle" },
  { id: "two", name: "Two", status: "idle" },
]
const sessions: WorkspaceSession[] = [
  { sessionId: "a", title: "A", status: "idle", updatedAt: "2026-09-06" },
  { sessionId: "b", title: "B", status: "idle", updatedAt: "2026-09-06" },
]

/** A slash command the palette can run with nothing typed. */
function slashCommand(
  id: string,
  name: string,
  title: string
): WorkspaceCommand {
  return {
    id,
    names: [name],
    title,
    description: "",
    available: true,
    palette: true,
    run: vi.fn(async () => undefined),
  }
}

function renderShell(props: Partial<WorkspaceShellProps> = {}) {
  return render(
    <WorkspaceShell
      locale="en"
      dictionary={en}
      agents={agents}
      openSessions={sessions}
      olderSessions={[]}
      selectedAgentId="one"
      activeThreadId="a"
      onSelectAgent={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseSession={vi.fn()}
      onCreateSession={vi.fn()}
      onOpenAgentBuilder={vi.fn()}
      {...props}
    >
      <div>Conversation</div>
    </WorkspaceShell>
  )
}

describe("workspace keyboard discovery", () => {
  it("opens Commands with the platform shortcut and reference with physical Mod+/", async () => {
    const user = userEvent.setup()
    renderShell()
    expect(screen.getByRole("button", { name: "Commands (❖+K)" })).toBeVisible()
    await user.keyboard("{Control>}k{/Control}")
    expect(screen.getByRole("dialog", { name: "Commands" })).toBeVisible()
    await user.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Commands" })).toBeNull()
    )
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "/",
        ctrlKey: true,
        cancelable: true,
      })
    )
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Keyboard reference" })
      ).toBeVisible()
    )
  })

  it("anchors Shift+F10's context menu inside the focused control", async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(screen.getByRole("button", { name: "Hide Agent details" }))
    const contextMenu = vi.fn()
    const tab = screen.getByRole("tab", { name: "A" })
    tab.focus()
    vi.spyOn(tab, "getBoundingClientRect").mockReturnValue({
      left: 40,
      right: 160,
      top: 12,
      bottom: 48,
      width: 120,
      height: 36,
    } as DOMRect)
    tab.addEventListener("contextmenu", contextMenu)
    await user.keyboard("{Shift>}{F10}{/Shift}")
    expect(contextMenu).toHaveBeenCalledOnce()
    // The menu must anchor inside the focused control, not at the viewport origin.
    const event = contextMenu.mock.calls[0]![0] as MouseEvent
    expect(event.clientX).toBeGreaterThanOrEqual(40)
    expect(event.clientX).toBeLessThan(160)
    expect(event.clientY).toBe(30)
  })

  it("renders one command for a session shared by open and older lists", async () => {
    const user = userEvent.setup()
    render(
      <WorkspaceShell
        locale="en"
        dictionary={en}
        agents={agents}
        openSessions={sessions}
        olderSessions={sessions}
        selectedAgentId="one"
        activeThreadId="a"
        onSelectAgent={vi.fn()}
        onOpenSession={vi.fn()}
        onCloseSession={vi.fn()}
        onCreateSession={vi.fn()}
        onOpenAgentBuilder={vi.fn()}
      >
        <div>Conversation</div>
      </WorkspaceShell>
    )

    await user.click(screen.getByRole("button", { name: "Commands (❖+K)" }))
    expect(
      screen.getAllByRole("button", { name: "Open Session: A" })
    ).toHaveLength(1)
  })

  it("lends a built-in action its slash spelling and adds the other slash commands", async () => {
    const user = userEvent.setup()
    const onCreateSession = vi.fn()
    const twin = slashCommand("workspace.newSession", "new", "Start afresh")
    const stop = slashCommand("command.stop", "stop", "Stop")
    renderShell({ onCreateSession, commands: [twin, stop] })
    const openCommands = () =>
      user.click(screen.getByRole("button", { name: "Commands (❖+K)" }))

    await openCommands()
    const newSession = screen.getAllByRole("button", { name: "New Session" })
    expect(newSession).toHaveLength(1)
    expect(newSession[0]).toHaveTextContent("/new")
    expect(screen.queryByRole("button", { name: "Start afresh" })).toBeNull()
    await user.click(newSession[0]!)
    // The twin keeps the built-in's own action.
    expect(onCreateSession).toHaveBeenCalledExactlyOnceWith("one")
    expect(twin.run).not.toHaveBeenCalled()

    await openCommands()
    await user.click(screen.getByRole("button", { name: "Stop" }))
    expect(stop.run).toHaveBeenCalledExactlyOnceWith("", {})
  })

  it("opens the palette and the command reference, and closes the active tab, when a command asks", async () => {
    const user = userEvent.setup()
    const surface = createSurfaceRequests()
    const onCloseSession = vi.fn()
    renderShell({
      surface,
      onCloseSession,
      openSessions: sessions.map((session) => ({ ...session, canClose: true })),
      commands: [slashCommand("command.stop", "stop", "Stop")],
    })

    act(() => surface.request("openPalette"))
    expect(
      await screen.findByRole("dialog", { name: "Commands" })
    ).toBeVisible()
    await user.keyboard("{Escape}")
    act(() => surface.request("openKeyboardReference"))
    const reference = await screen.findByRole("dialog", {
      name: "Keyboard reference",
    })
    expect(
      within(reference).getByRole("region", { name: "Slash commands" })
    ).toHaveTextContent("Stop/stop")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    act(() => surface.request("closeActiveTab"))
    expect(onCloseSession).toHaveBeenCalledExactlyOnceWith("a", "one")
  })

  it("opens conversation search from Mod+F and Commands without taking composer history keys", async () => {
    const user = userEvent.setup()
    const openSearch = vi.fn()
    window.addEventListener("aos:conversation-search", openSearch)
    renderShell()

    await user.keyboard("{Control>}f{/Control}")
    expect(openSearch).toHaveBeenCalledOnce()

    await user.click(screen.getByRole("button", { name: "Commands (❖+K)" }))
    await user.click(
      screen.getByRole("button", { name: "Search in conversation" })
    )
    expect(openSearch).toHaveBeenCalledTimes(2)
    window.removeEventListener("aos:conversation-search", openSearch)
  })
})
