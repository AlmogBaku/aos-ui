import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"

import {
  WorkspaceShell,
  type WorkspaceAgent,
  type WorkspaceSession,
} from "@/components/workspace/workspace-shell"

vi.mock("next/navigation", () => ({
  usePathname: () => "/en",
  useRouter: () => ({ replace: vi.fn() }),
}))
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
  { threadId: "a", title: "A", status: "idle", updatedAt: "2026-09-06" },
  { threadId: "b", title: "B", status: "idle", updatedAt: "2026-09-06" },
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
  it("opens Commands with Mod+K and reference with physical Mod+/", async () => {
    const user = userEvent.setup()
    renderShell()
    expect(
      screen.getByRole("button", { name: "Commands (Mod+K)" })
    ).toBeVisible()
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

  it("moves through visible regions with F6 and dispatches Shift+F10 to the focused control", async () => {
    const user = userEvent.setup()
    renderShell()
    const firstAgent = screen.getByRole("button", { name: /^One,/ })
    firstAgent.focus()
    await user.keyboard("{F6}")
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "A" })).toHaveFocus()
    )

    const contextMenu = vi.fn()
    screen
      .getByRole("tab", { name: "A" })
      .addEventListener("contextmenu", contextMenu)
    await user.keyboard("{Shift>}{F10}{/Shift}")
    expect(contextMenu).toHaveBeenCalledOnce()
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

    await user.click(screen.getByRole("button", { name: "Commands (Mod+K)" }))
    expect(
      screen.getAllByRole("button", { name: "Open Session: A" })
    ).toHaveLength(1)
  })
})
