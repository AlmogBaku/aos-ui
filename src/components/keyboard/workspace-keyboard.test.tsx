import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"

import {
  WorkspaceShell,
  type WorkspaceAgent,
  type WorkspaceSession,
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

function renderShell() {
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
    >
      <div>Conversation</div>
    </WorkspaceShell>
  )
}

describe("workspace keyboard discovery", () => {
  it("anchors Shift+F10's context menu inside the focused control", async () => {
    const user = userEvent.setup()
    renderShell()
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
