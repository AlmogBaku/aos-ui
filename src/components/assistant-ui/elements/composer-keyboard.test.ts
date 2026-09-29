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
  plainEnterSends: true,
  ...overrides,
})

describe("composer keyboard decisions", () => {
  it.each<
    [
      string,
      Parameters<typeof resolveComposerEnterAction>[0],
      Partial<ComposerEnterState>,
      ReturnType<typeof resolveComposerEnterAction>,
    ]
  >([
    ["a desktop draft on plain Enter", { key: "Enter" }, {}, "send"],
    [
      "plain Enter on a touch-primary device",
      { key: "Enter" },
      { plainEnterSends: false },
      "newline",
    ],
    ["idle Command+Enter", { key: "Enter", metaKey: true }, {}, "send"],
    ["idle Ctrl+Enter", { key: "Enter", ctrlKey: true }, {}, "send"],
    [
      "the steering shortcut while idle",
      { key: "Enter", metaKey: true, shiftKey: true },
      {},
      "send",
    ],
    [
      "busy Ctrl+Enter, without steering",
      { key: "Enter", ctrlKey: true },
      { isRunning: true, hasQueue: true },
      "queue",
    ],
    [
      "a busy desktop draft on plain Enter",
      { key: "Enter" },
      { isRunning: true, hasQueue: true },
      "queue",
    ],
    [
      "the steering shortcut into the active turn",
      { key: "Enter", ctrlKey: true, shiftKey: true },
      { isRunning: true, canSteer: true },
      "steer",
    ],
    [
      "the steering shortcut when steering is unavailable",
      { key: "Enter", metaKey: true, shiftKey: true },
      { isRunning: true, hasQueue: true, canSteer: false },
      "queue",
    ],
    [
      "the steering shortcut for a draft with attachments",
      { key: "Enter", ctrlKey: true, shiftKey: true },
      { isRunning: true, hasQueue: true, canSteer: true, hasAttachments: true },
      "queue",
    ],
    ["Shift+Enter", { key: "Enter", shiftKey: true }, {}, "newline"],
    ["an empty draft", { key: "Enter" }, { isEmpty: true }, "noop"],
    [
      "busy Ctrl+Enter without queue support",
      { key: "Enter", ctrlKey: true },
      { isRunning: true, hasQueue: false },
      "noop",
    ],
    ["an IME composition", { key: "Enter", isComposing: true }, {}, "noop"],
    [
      "an already-consumed event",
      { key: "Enter", defaultPrevented: true },
      {},
      "noop",
    ],
    [
      "native editing (native keyCode 229)",
      { key: "Enter", nativeEvent: { keyCode: 229 } },
      {},
      "noop",
    ],
    [
      "native editing (keyCode 229)",
      { key: "Enter", keyCode: 229 },
      {},
      "noop",
    ],
  ])("resolves %s", (_case, event, overrides, action) => {
    expect(resolveComposerEnterAction(event, state(overrides))).toBe(action)
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
