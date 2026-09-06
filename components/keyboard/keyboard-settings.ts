import {
  bindingSignature,
  normalizeBinding,
  type KeyboardBindingInput,
  type KeyboardBindingOverrides,
  type KeyboardLocale,
  type NormalizedKeyboardBinding,
} from "@/lib/keyboard"

export const KEYBOARD_OVERRIDES_STORAGE_KEY = "aos_ui:keyboard:overrides"
export const KEYBOARD_OVERRIDES_EVENT = "aos_ui:keyboard-overrides-change"

export type KeyboardOverrideMap = Readonly<KeyboardBindingOverrides>

function isBindingInput(value: unknown): value is KeyboardBindingInput {
  if (typeof value === "string") return value.trim().length > 0
  if (!value || typeof value !== "object") return false
  const candidate = value as { key?: unknown }
  return typeof candidate.key === "string" && candidate.key.trim().length > 0
}

function isOverrideValue(
  value: unknown
): value is KeyboardBindingInput | readonly KeyboardBindingInput[] | null {
  if (value === null || isBindingInput(value)) return true
  return Array.isArray(value) && value.every(isBindingInput)
}

export function readKeyboardOverrides(): KeyboardOverrideMap {
  if (typeof window === "undefined") return {}
  try {
    const serialized = window.localStorage.getItem(
      KEYBOARD_OVERRIDES_STORAGE_KEY
    )
    if (!serialized) return {}
    const parsed: unknown = JSON.parse(serialized)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    const result: Record<
      string,
      KeyboardBindingInput | readonly KeyboardBindingInput[] | null
    > = {}
    for (const [actionId, value] of Object.entries(parsed)) {
      if (isOverrideValue(value)) result[actionId] = value
    }
    return result
  } catch {
    return {}
  }
}

export function writeKeyboardOverrides(overrides: KeyboardOverrideMap) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      KEYBOARD_OVERRIDES_STORAGE_KEY,
      JSON.stringify(overrides)
    )
    window.dispatchEvent(new Event(KEYBOARD_OVERRIDES_EVENT))
  } catch {
    // Settings remain usable for this visit when browser storage is blocked.
  }
}

export function resetKeyboardOverrides() {
  writeKeyboardOverrides({})
}

export type KeyboardValidationResult =
  | { readonly valid: true; readonly binding: NormalizedKeyboardBinding }
  | {
      readonly valid: false
      readonly reason: "invalid" | "reserved" | "conflict"
      readonly binding?: NormalizedKeyboardBinding
    }

const RESERVED_SIGNATURES = new Set([
  "Meta+n",
  "Ctrl+n",
  "Meta+p",
  "Ctrl+p",
  "Ctrl+Tab",
  "Meta+Tab",
  "Ctrl+j",
])

export function validateKeyboardBinding(
  actionId: string,
  input: KeyboardBindingInput,
  actions: ReadonlyArray<{
    id: string
    bindings: readonly KeyboardBindingInput[]
  }> = []
): KeyboardValidationResult {
  void actionId
  let binding: NormalizedKeyboardBinding
  try {
    binding = normalizeBinding(input)
  } catch {
    return { valid: false, reason: "invalid" }
  }
  if (RESERVED_SIGNATURES.has(binding.signature)) {
    return { valid: false, reason: "reserved", binding }
  }
  if (
    actions.some(
      (action) =>
        action.id !== actionId &&
        action.bindings.some(
          (candidate) => bindingSignature(candidate) === binding.signature
        )
    )
  ) {
    return { valid: false, reason: "conflict", binding }
  }
  return { valid: true, binding }
}

export function formatKeyboardBinding(
  input: KeyboardBindingInput | NormalizedKeyboardBinding,
  locale: KeyboardLocale
) {
  void locale
  const binding = normalizeBinding(input)
  const modifiers: string[] = []
  if (binding.altGraph) modifiers.push("AltGraph")
  else {
    if (binding.ctrl || binding.meta) modifiers.push("Mod")
    if (binding.alt) modifiers.push("Alt")
    if (binding.shift) modifiers.push("Shift")
  }
  const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key
  return [...modifiers, key].join("+")
}

export function formatKeyboardBindings(
  inputs: readonly (KeyboardBindingInput | NormalizedKeyboardBinding)[],
  locale: KeyboardLocale
) {
  return [
    ...new Set(inputs.map((input) => formatKeyboardBinding(input, locale))),
  ]
}

export function bindingInputsFromOverride(
  value:
    KeyboardBindingInput | readonly KeyboardBindingInput[] | null | undefined
): readonly KeyboardBindingInput[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value as KeyboardBindingInput]
}
