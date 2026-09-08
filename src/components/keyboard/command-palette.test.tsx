import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CommandPalette, type KeyboardCommand } from "./command-palette"

afterEach(cleanup)

describe("CommandPalette", () => {
  it("filters commands and explains unavailable actions", async () => {
    const user = userEvent.setup()
    const run = vi.fn()
    const commands: KeyboardCommand[] = [
      { id: "new", title: "New Session", binding: "Mod+K", onRun: run },
      {
        id: "agents",
        title: "Focus Agents",
        unavailableReason: "No Agents are available",
      },
    ]
    render(
      <CommandPalette
        open
        locale="en"
        commands={commands}
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByRole("dialog", { name: "Commands" })).toBeVisible()
    expect(screen.getByText("Mod+K")).toBeVisible()
    await user.type(screen.getByRole("searchbox"), "new")
    expect(screen.getByRole("button", { name: "New Session" })).toBeVisible()
    expect(
      screen.queryByText("No Agents are available")
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "New Session" }))
    expect(run).toHaveBeenCalledOnce()
  })
})
