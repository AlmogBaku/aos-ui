import {
  KEYBOARD_ACTION_CATALOG,
  type KeyboardActionDefinition,
  type KeyboardActionId,
} from "@/lib/keyboard"

const text = (en: string, he: string) => ({ en, he })
const action = <T extends string>(
  id: T,
  title: { en: string; he: string },
  scope: KeyboardActionDefinition["scope"] = "workspace",
  bindings: readonly string[] = [],
  allowInEditable = false
) =>
  ({
    id: id as KeyboardActionId,
    title,
    scope,
    bindings,
    allowInEditable,
  }) satisfies KeyboardActionDefinition

export const WORKSPACE_KEYBOARD_ACTIONS = [
  action("workspace.newAgent", text("New Agent", "סוכן חדש")),
  action("workspace.newSession", text("New Session", "שיחה חדשה")),
  action(
    "conversation.search",
    text("Search in conversation", "חיפוש בשיחה"),
    "workspace",
    ["Meta+f", "Ctrl+f"],
    true
  ),
  action(
    "keyboard.reference",
    text("Keyboard reference", "מקשי קיצור"),
    "settings",
    ["Meta+/", "Ctrl+/"]
  ),
  action(
    "workspace.contextMenu",
    text("Open context menu", "פתיחת תפריט הקשר"),
    "workspace",
    ["Shift+F10"],
    true
  ),
] as const

export const KEYBOARD_UI_CATALOG: readonly KeyboardActionDefinition[] = [
  ...KEYBOARD_ACTION_CATALOG,
  ...WORKSPACE_KEYBOARD_ACTIONS,
]

export type WorkspaceKeyboardActionId =
  | (typeof WORKSPACE_KEYBOARD_ACTIONS)[number]["id"]
  | (typeof KEYBOARD_ACTION_CATALOG)[number]["id"]
