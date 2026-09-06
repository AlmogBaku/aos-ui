/** The locales supported by the workspace's keyboard UI. */
export type KeyboardLocale = "en" | "he"

export type LocalizedKeyboardText = Readonly<Record<KeyboardLocale, string>>

/**
 * Stable IDs are deliberately independent from their labels. Consumers can
 * use these IDs from Commands, settings, or a focus coordinator without
 * coupling keyboard behavior to translated copy.
 */
export type KeyboardActionId = string & {}

export type KeyboardScope =
  "global" | "workspace" | "composer" | "commands" | "settings" | "question"

export type KeyboardBindingInput =
  | string
  | {
      key: string
      ctrl?: boolean
      alt?: boolean
      shift?: boolean
      meta?: boolean
      altGraph?: boolean
    }

export type KeyboardActionDefinition = {
  readonly id: KeyboardActionId
  readonly title: LocalizedKeyboardText
  readonly description?: LocalizedKeyboardText
  readonly scope: KeyboardScope
  readonly bindings: readonly KeyboardBindingInput[]
  /** Global focus movement may be useful even while an editor has focus. */
  readonly allowInEditable?: boolean
}

const text = (en: string, he: string): LocalizedKeyboardText => ({ en, he })

/**
 * The small, provider-neutral action vocabulary shared by future keyboard
 * surfaces. The catalogue contains no handlers; ownership is supplied by the
 * surface currently able to perform an action.
 */
export const KEYBOARD_ACTION_CATALOG = [
  {
    id: "workspace.focusNextPane",
    title: text("Focus next pane", "מעבר לחלונית הבאה"),
    description: text(
      "Move focus between the Agents, Sessions, conversation, and inspector panes.",
      "העברת המיקוד בין חלוניות הסוכנים, הסשנים, השיחה והמפקח."
    ),
    scope: "workspace",
    bindings: ["F6"],
    allowInEditable: true,
  },
  {
    id: "workspace.focusPreviousPane",
    title: text("Focus previous pane", "מעבר לחלונית הקודמת"),
    scope: "workspace",
    bindings: ["Shift+F6"],
    allowInEditable: true,
  },
  {
    id: "workspace.focusAgents",
    title: text("Focus Agents", "מיקוד בסוכנים"),
    scope: "workspace",
    bindings: [],
  },
  {
    id: "workspace.focusSessions",
    title: text("Focus Sessions", "מיקוד בסשנים"),
    scope: "workspace",
    bindings: [],
  },
  {
    id: "workspace.focusConversation",
    title: text("Focus conversation", "מיקוד בשיחה"),
    scope: "workspace",
    bindings: [],
  },
  {
    id: "workspace.focusInspector",
    title: text("Focus inspector", "מיקוד במפקח"),
    scope: "workspace",
    bindings: [],
  },
  {
    id: "workspace.nextAgent",
    title: text("Select next Agent", "בחירת הסוכן הבא"),
    scope: "workspace",
    bindings: [],
  },
  {
    id: "workspace.previousAgent",
    title: text("Select previous Agent", "בחירת הסוכן הקודם"),
    scope: "workspace",
    bindings: [],
  },
  {
    id: "workspace.nextSession",
    title: text("Select next Session", "בחירת הסשן הבא"),
    scope: "workspace",
    bindings: [],
  },
  {
    id: "workspace.previousSession",
    title: text("Select previous Session", "בחירת הסשן הקודם"),
    scope: "workspace",
    bindings: [],
  },
  {
    id: "commands.open",
    title: text("Open Commands", "פתיחת פקודות"),
    description: text(
      "Search available workspace actions.",
      "חיפוש פעולות זמינות בסביבת העבודה."
    ),
    scope: "commands",
    bindings: ["Meta+K", "Ctrl+K"],
  },
  {
    id: "settings.openKeyboard",
    title: text("Open keyboard settings", "פתיחת הגדרות מקלדת"),
    description: text(
      "Review and customize keyboard bindings.",
      "סקירה והתאמה אישית של קיצורי המקלדת."
    ),
    scope: "settings",
    bindings: ["Meta+Shift+?", "Ctrl+Shift+?"],
  },
] as const satisfies readonly KeyboardActionDefinition[]

export type CatalogKeyboardActionId =
  (typeof KEYBOARD_ACTION_CATALOG)[number]["id"]

/** Alias with a descriptive name for settings and command consumers. */
export const keyboardActionCatalog = KEYBOARD_ACTION_CATALOG
