import { afterEach, describe, expect, it } from "vitest"

import {
  KEYBOARD_OVERRIDES_STORAGE_KEY,
  formatKeyboardBinding,
  formatKeyboardBindings,
  readKeyboardOverrides,
  validateKeyboardBinding,
  writeKeyboardOverrides,
} from "./keyboard-settings"

afterEach(() => {
  window.localStorage.clear()
})

describe("keyboard settings persistence", () => {
  it("round trips overrides by stable action id", () => {
    const overrides = { "commands.open": ["Ctrl+Shift+p"] }

    writeKeyboardOverrides(overrides)

    expect(readKeyboardOverrides()).toEqual(overrides)
  })

  it("ignores malformed persisted values", () => {
    window.localStorage.setItem(KEYBOARD_OVERRIDES_STORAGE_KEY, "not-json")

    expect(readKeyboardOverrides()).toEqual({})
  })
})

describe("keyboard settings validation", () => {
  it("rejects browser-reserved navigation shortcuts", () => {
    expect(validateKeyboardBinding("workspace.newSession", "Meta+N")).toEqual(
      expect.objectContaining({ valid: false, reason: "reserved" })
    )
    expect(validateKeyboardBinding("workspace.newSession", "Ctrl+Tab")).toEqual(
      expect.objectContaining({ valid: false, reason: "reserved" })
    )
    expect(validateKeyboardBinding("workspace.newSession", "Ctrl+J")).toEqual(
      expect.objectContaining({ valid: false, reason: "reserved" })
    )
  })

  it("reports conflicts with another effective action", () => {
    expect(
      validateKeyboardBinding("workspace.newSession", "Meta+K", [
        { id: "commands.open", bindings: ["Meta+K"] },
      ])
    ).toEqual(expect.objectContaining({ valid: false, reason: "conflict" }))
  })

  it("formats modifier keys with the macOS Command symbol", () => {
    expect(formatKeyboardBinding("Meta+Shift+k", "en", "mac")).toBe("⌘+Shift+K")
  })

  it("formats modifier keys with the Windows Super symbol", () => {
    expect(formatKeyboardBinding("Ctrl+Shift+k", "en", "windows")).toBe(
      "❖+Shift+K"
    )
  })

  it("deduplicates platform-equivalent alternatives", () => {
    expect(formatKeyboardBindings(["Meta+K", "Ctrl+K"], "en")).toEqual(["❖+K"])
  })
})
