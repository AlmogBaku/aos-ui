import { describe, expect, it } from "vitest"

import {
  isCollapsedCaretAtVisualLineBoundary,
  resolveComposerEnterAction,
  type ComposerEnterState,
} from "./composer-keyboard"

const state = (overrides: Partial<ComposerEnterState> = {}) => ({
  isRunning: false,
  hasQueue: false,
  isEmpty: false,
  ...overrides,
})

describe("composer keyboard decisions", () => {
  it("submits a non-empty draft on idle Enter", () => {
    expect(resolveComposerEnterAction({ key: "Enter" }, state())).toBe("send")
  })

  it("submits the steering shortcut normally while idle", () => {
    expect(
      resolveComposerEnterAction(
        { key: "Enter", metaKey: true, shiftKey: true },
        state()
      )
    ).toBe("send")
  })

  it("queues a non-empty draft on busy Enter without steering", () => {
    expect(
      resolveComposerEnterAction(
        { key: "Enter" },
        state({ isRunning: true, hasQueue: true })
      )
    ).toBe("queue")
  })

  it("steers a text-only draft into the active turn", () => {
    expect(
      resolveComposerEnterAction(
        { key: "Enter", ctrlKey: true, shiftKey: true },
        state({ isRunning: true, canSteer: true })
      )
    ).toBe("steer")
  })

  it("queues steering shortcuts when steering or text-only delivery is unavailable", () => {
    expect(
      resolveComposerEnterAction(
        { key: "Enter", metaKey: true, shiftKey: true },
        state({ isRunning: true, hasQueue: true, canSteer: false })
      )
    ).toBe("queue")
    expect(
      resolveComposerEnterAction(
        { key: "Enter", ctrlKey: true, shiftKey: true },
        state({
          isRunning: true,
          hasQueue: true,
          canSteer: true,
          hasAttachments: true,
        })
      )
    ).toBe("queue")
  })

  it("keeps Shift+Enter as a native newline", () => {
    expect(
      resolveComposerEnterAction({ key: "Enter", shiftKey: true }, state())
    ).toBe("newline")
  })

  it("does not submit an empty draft or a busy thread without queue support", () => {
    expect(
      resolveComposerEnterAction({ key: "Enter" }, state({ isEmpty: true }))
    ).toBe("noop")
    expect(
      resolveComposerEnterAction(
        { key: "Enter" },
        state({ isRunning: true, hasQueue: false })
      )
    ).toBe("noop")
  })

  it("lets IME, native editing, and an already-consumed event win", () => {
    expect(
      resolveComposerEnterAction({ key: "Enter", isComposing: true }, state())
    ).toBe("noop")
    expect(
      resolveComposerEnterAction(
        { key: "Enter", defaultPrevented: true },
        state()
      )
    ).toBe("noop")
    expect(
      resolveComposerEnterAction(
        { key: "Enter", nativeEvent: { keyCode: 229 } },
        state()
      )
    ).toBe("noop")
    expect(
      resolveComposerEnterAction({ key: "Enter", keyCode: 229 }, state())
    ).toBe("noop")
  })

  it("gates navigation on a collapsed first or last visual line caret", () => {
    expect(
      isCollapsedCaretAtVisualLineBoundary({
        value: "first\nlast",
        selectionStart: 0,
        selectionEnd: 0,
        boundary: "first",
      })
    ).toBe(true)
    expect(
      isCollapsedCaretAtVisualLineBoundary({
        value: "first\nlast",
        selectionStart: 6,
        selectionEnd: 6,
        boundary: "first",
      })
    ).toBe(false)
    expect(
      isCollapsedCaretAtVisualLineBoundary({
        value: "first\nlast",
        selectionStart: "first\nlast".length,
        selectionEnd: "first\nlast".length,
        boundary: "last",
      })
    ).toBe(true)
    expect(
      isCollapsedCaretAtVisualLineBoundary({
        value: "wrapped text",
        selectionStart: 6,
        selectionEnd: 6,
        boundary: "first",
        measure: () => false,
      })
    ).toBe(false)
  })
})
