import { waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createFocusRegionCoordinator,
  getVisibleFocusRegions,
  observeKeyboardRegions,
} from "./focus-regions"

afterEach(() => document.body.replaceChildren())

function region(name: string, hidden = false) {
  const element = document.createElement("section")
  element.dataset.keyboardRegion = name
  element.tabIndex = -1
  if (hidden) element.hidden = true
  const first = document.createElement("button")
  first.textContent = `${name} first`
  const second = document.createElement("button")
  second.textContent = `${name} second`
  element.append(first, second)
  Object.defineProperty(element, "getClientRects", {
    configurable: true,
    value: () => [{ width: 100, height: 40 }],
  })
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 100, height: 40 }),
  })
  document.body.append(element)
  return { element, first, second }
}

describe("workspace focus regions", () => {
  it("skips hidden and inert regions while preserving document order", () => {
    const agents = region("agents")
    region("transcript", true)
    const composer = region("composer")
    composer.element.inert = true

    expect(getVisibleFocusRegions(document.body)).toEqual([agents.element])
  })

  it("cycles regions and restores the last descendant focused in each region", () => {
    const agents = region("agents")
    const transcript = region("transcript")
    const coordinator = createFocusRegionCoordinator()

    agents.second.focus()
    coordinator.remember(agents.element)
    expect(coordinator.focusNext(document.body, agents.element)).toBe(true)
    expect(transcript.element).toHaveFocus()

    coordinator.remember(transcript.element)
    expect(coordinator.focusPrevious(document.body, transcript.element)).toBe(
      true
    )
    expect(agents.second).toHaveFocus()
  })

  it("keeps a nested transcript region before its composer", () => {
    const conversation = region("conversation")
    const transcript = region("transcript")
    const composer = region("composer")
    transcript.element.dataset.keyboardTranscript = "true"
    composer.element.dataset.keyboardComposer = "true"
    conversation.element.append(transcript.element)
    transcript.element.append(composer.element)

    expect(getVisibleFocusRegions(conversation.element)).toEqual([
      transcript.element,
      composer.element,
    ])
  })

  it("excludes CSS-hidden, zero-size, and disabled targets", () => {
    const hidden = region("hidden")
    hidden.element.style.display = "none"
    const zero = region("zero")
    Object.defineProperty(zero.element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 0, height: 0 }),
    })
    const disabled = region("disabled")
    disabled.element.removeAttribute("tabindex")
    disabled.first.disabled = true
    disabled.second.disabled = true

    expect(getVisibleFocusRegions(document.body)).toEqual([])
  })

  it("reports failed focus instead of claiming a region was focused", () => {
    const agents = region("agents")
    vi.spyOn(agents.element, "focus").mockImplementation(() => undefined)
    const coordinator = createFocusRegionCoordinator()

    expect(coordinator.focusNext(document.body)).toBe(false)
  })

  it("annotates late-mounted and remounted provider regions", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const stop = observeKeyboardRegions(root)
    const first = document.createElement("div")
    first.dataset.slot = "aui_thread-viewport"
    root.append(first)
    await waitFor(() =>
      expect(first).toHaveAttribute("data-keyboard-transcript", "true")
    )

    const second = document.createElement("div")
    second.dataset.slot = "aui_thread-viewport"
    root.replaceChildren(second)
    await waitFor(() =>
      expect(second).toHaveAttribute("data-keyboard-transcript", "true")
    )
    stop()
  })
})
