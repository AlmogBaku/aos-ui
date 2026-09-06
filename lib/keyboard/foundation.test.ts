import { describe, expect, it, vi } from "vitest"

import {
  KEYBOARD_ACTION_CATALOG,
  createKeyboardDispatcher,
  normalizeBinding,
  normalizeBindingOverrides,
  normalizeKeyboardEvent,
  resolveEffectiveBindings,
  keyboardEventSafetyReason,
  type KeyboardActionId,
} from "@/lib/keyboard"

describe("keyboard action catalogue", () => {
  it("keeps actions uniquely identified and ready for both locales", () => {
    const ids = KEYBOARD_ACTION_CATALOG.map((action) => action.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(KEYBOARD_ACTION_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "workspace.focusNextPane",
          title: { en: expect.any(String), he: expect.any(String) },
        }),
        expect.objectContaining({
          id: "commands.open",
          title: { en: expect.any(String), he: expect.any(String) },
        }),
        expect.objectContaining({
          id: "settings.openKeyboard",
          title: { en: expect.any(String), he: expect.any(String) },
        }),
      ])
    )
  })
})

describe("keyboard bindings", () => {
  it("normalizes aliases, modifier order, and case to one stable binding", () => {
    expect(normalizeBinding("shift + CTRL + k")).toEqual(
      normalizeBinding({ key: "K", ctrl: true, shift: true })
    )
    expect(normalizeBinding("Esc").key).toBe("Escape")
    expect(normalizeBinding({ key: " " }).key).toBe("Space")
    expect(normalizeBinding("Ctrl+AltGraph+א")).toMatchObject({
      key: "א",
      altGraph: true,
      ctrl: false,
      alt: false,
    })
  })

  it("uses an override to replace defaults and null to disable an action", () => {
    const overrides = normalizeBindingOverrides({
      "commands.open": ["Ctrl+Shift+p"],
      "settings.openKeyboard": null,
    })
    const effective = resolveEffectiveBindings(
      KEYBOARD_ACTION_CATALOG,
      overrides
    )

    expect(
      effective.find((action) => action.id === "commands.open")?.bindings
    ).toEqual([normalizeBinding("Ctrl+Shift+p")])
    expect(
      effective.find((action) => action.id === "settings.openKeyboard")
        ?.bindings
    ).toEqual([])
  })

  it.each([
    { name: "modifier-only", key: "Control" },
    { name: "empty", key: "" },
    { name: "missing", key: undefined },
    { name: "unidentified", key: "Unidentified" },
    { name: "non-string", key: {} },
  ])("declines $name keyboard events without throwing", ({ key }) => {
    const event = {
      key,
      ctrlKey: key === "Control",
      preventDefault: vi.fn(),
    }

    let binding: ReturnType<typeof normalizeKeyboardEvent>
    expect(() => {
      binding = normalizeKeyboardEvent(event)
    }).not.toThrow()
    expect(binding).toBeUndefined()
  })

  it("normalizes a valid raw keyboard event", () => {
    const event = new KeyboardEvent("keydown", {
      key: "K",
      ctrlKey: true,
    })

    expect(normalizeKeyboardEvent(event)).toMatchObject({
      key: "k",
      ctrl: true,
      signature: "Ctrl+k",
    })
  })
})

describe("keyboard ownership dispatch", () => {
  it("gives a matching action to the first eligible owner and prevents only then", () => {
    const calls: string[] = []
    const dispatcher = createKeyboardDispatcher({
      owners: [
        {
          id: "settings",
          priority: 20,
          actions: ["commands.open"],
          handle: () => {
            calls.push("settings")
            return false
          },
        },
        {
          id: "commands",
          priority: 10,
          actions: ["commands.open"],
          handle: (action) => {
            calls.push(action)
            return true
          },
        },
      ],
    })
    const event = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      cancelable: true,
    })

    expect(dispatcher.dispatch(event)).toMatchObject({
      handled: true,
      actionId: "commands.open",
      ownerId: "commands",
    })
    expect(calls).toEqual(["settings", "commands.open"])
    expect(event.defaultPrevented).toBe(true)
  })

  it("does not prevent unhandled, composed, dead-key, AltGraph, or native-editable input", () => {
    const handle = vi.fn(() => true)
    const dispatcher = createKeyboardDispatcher({
      owners: [{ id: "commands", actions: ["commands.open"], handle }],
    })
    const editable = document.createElement("textarea")
    const cases = [
      new KeyboardEvent("keydown", { key: "x", cancelable: true }),
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        isComposing: true,
        cancelable: true,
      }),
      new KeyboardEvent("keydown", {
        key: "Dead",
        ctrlKey: true,
        cancelable: true,
      }),
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        cancelable: true,
      }),
    ]
    Object.defineProperty(cases[3], "target", { value: editable })
    Object.defineProperty(cases[3], "currentTarget", { value: editable })
    const altGraph = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    })
    Object.defineProperty(altGraph, "getModifierState", {
      value: (name: string) => name === "AltGraph",
    })
    cases.push(altGraph)

    for (const event of cases) {
      expect(dispatcher.dispatch(event).handled).toBe(false)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(handle).not.toHaveBeenCalled()
  })

  it("declines malformed browser key events without crashing the dispatcher", () => {
    const dispatcher = createKeyboardDispatcher()
    const keys = ["Control", "", undefined, "Unidentified", {}]

    for (const key of keys) {
      const event = {
        key,
        preventDefault: vi.fn(),
      }

      let result: ReturnType<typeof dispatcher.dispatch> | undefined
      expect(() => {
        result = dispatcher.dispatch(event)
      }).not.toThrow()
      expect(result).toMatchObject({
        handled: false,
        reason: "unbound",
      })
    }
  })

  it("allows the pane-cycle action from an editable while preserving normal editing actions", () => {
    const handle = vi.fn(() => true)
    const dispatcher = createKeyboardDispatcher({
      owners: [
        { id: "workspace", actions: ["workspace.focusNextPane"], handle },
      ],
    })
    const input = document.createElement("input")
    const event = new KeyboardEvent("keydown", { key: "F6", cancelable: true })
    Object.defineProperty(event, "target", { value: input })
    Object.defineProperty(event, "currentTarget", { value: input })

    expect(dispatcher.dispatch(event)).toMatchObject({
      handled: true,
      actionId: "workspace.focusNextPane",
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it("supports typed action IDs for downstream command and settings owners", () => {
    const action: KeyboardActionId = "commands.open"
    expect(action).toBe("commands.open")
  })

  it("honors composition reported by a React-style native event", () => {
    const handle = vi.fn(() => true)
    const dispatcher = createKeyboardDispatcher({
      owners: [{ id: "commands", actions: ["commands.open"], handle }],
    })
    const event = {
      key: "k",
      ctrlKey: true,
      nativeEvent: { isComposing: true },
      preventDefault: vi.fn(),
    }

    expect(dispatcher.dispatch(event).reason).toBe("composing")
    expect(handle).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it.each([{ keyCode: 229 }, { nativeEvent: { keyCode: 229 } }])(
    "treats keyCode 229 as composing",
    (event) => {
      expect(
        keyboardEventSafetyReason({
          key: "k",
          ...event,
          preventDefault: vi.fn(),
        })
      ).toBe("composing")
    }
  )
})
