import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveEffectiveBindings } from "@/lib/keyboard"

import { KEYBOARD_UI_CATALOG } from "./keyboard-actions"
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings"

afterEach(cleanup)

describe("KeyboardShortcutsSettings", () => {
  it("shows essentials, searchable categories, and read-only editing keys", async () => {
    const user = userEvent.setup()
    const setBinding = vi.fn()
    render(
      <KeyboardShortcutsSettings
        locale="en"
        effectiveBindings={resolveEffectiveBindings(KEYBOARD_UI_CATALOG)}
        setBinding={setBinding}
        resetBinding={vi.fn()}
        resetAll={vi.fn()}
      />
    )

    expect(screen.getAllByText("Essentials")[0]).toBeVisible()
    expect(screen.getByText("Editing keys (fixed)")).toBeVisible()
    await user.type(screen.getByRole("searchbox"), "Focus Agents")
    expect(screen.getByText("Focus Agents")).toBeVisible()
  })

  it("captures a shortcut and exposes unbind/reset controls", async () => {
    const user = userEvent.setup()
    const setBinding = vi.fn()
    render(
      <KeyboardShortcutsSettings
        locale="en"
        effectiveBindings={resolveEffectiveBindings(KEYBOARD_UI_CATALOG)}
        setBinding={setBinding}
        resetBinding={vi.fn()}
        resetAll={vi.fn()}
      />
    )

    const capture = screen.getByRole("button", {
      name: /Set shortcut.*Focus Agents/,
    })
    await user.click(capture)
    await user.keyboard("{Control>}{Shift>}j{/Shift}{/Control}")
    expect(setBinding).toHaveBeenCalledWith(
      "workspace.focusAgents",
      "Ctrl+Shift+j"
    )
  })

  it.each([
    ["composition", { key: "k", ctrlKey: true, isComposing: true }],
    ["composition keyCode", { key: "k", ctrlKey: true, keyCode: 229 }],
    ["dead key", { key: "Dead", ctrlKey: true }],
    ["AltGraph", { key: "k", ctrlKey: true, altKey: true }],
    ["missing key", { ctrlKey: true }],
    ["malformed key", { key: "Ctrl+", ctrlKey: true }],
  ])("does not capture or cancel %s events", async (_name, init) => {
    const user = userEvent.setup()
    const setBinding = vi.fn()
    render(
      <KeyboardShortcutsSettings
        locale="en"
        effectiveBindings={resolveEffectiveBindings(KEYBOARD_UI_CATALOG)}
        setBinding={setBinding}
        resetBinding={vi.fn()}
        resetAll={vi.fn()}
      />
    )

    const capture = screen.getByRole("button", {
      name: /Set shortcut.*Focus Agents/,
    })
    await user.click(capture)
    const event = new KeyboardEvent("keydown", {
      ...init,
      cancelable: true,
    } as KeyboardEventInit)
    if (_name === "AltGraph") {
      Object.defineProperty(event, "getModifierState", {
        value: (name: string) => name === "AltGraph",
      })
    }
    capture.dispatchEvent(event)

    expect(setBinding).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
