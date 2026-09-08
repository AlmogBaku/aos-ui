import {
  KEYBOARD_ACTION_CATALOG,
  type KeyboardActionDefinition,
  type KeyboardActionId,
  type KeyboardBindingInput,
} from "./actions"

export type KeyboardModifier = "ctrl" | "alt" | "shift" | "meta" | "altGraph"

export type NormalizedKeyboardBinding = Readonly<{
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  altGraph: boolean
  /** Stable, modifier-order-independent lookup key. */
  signature: string
}>

export type KeyboardBindingOverrides = Readonly<
  Partial<
    Record<
      KeyboardActionId,
      KeyboardBindingInput | readonly KeyboardBindingInput[] | null
    >
  >
>

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  space: "Space",
  " ": "Space",
  tab: "Tab",
  del: "Delete",
  delete: "Delete",
  backspace: "Backspace",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
}

const normalizeKey = (key: string): string => {
  if (key === " ") return "Space"
  const trimmed = key.trim()
  if (!trimmed) throw new TypeError("Keyboard binding key cannot be empty")
  const alias = KEY_ALIASES[trimmed.toLowerCase()]
  if (alias) return alias
  if (/^f\d{1,2}$/i.test(trimmed)) return trimmed.toUpperCase()
  if (trimmed.length === 1 && /[a-z]/i.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return trimmed
}

const modifierName = (token: string): KeyboardModifier | undefined => {
  switch (token.trim().toLowerCase()) {
    case "ctrl":
    case "control":
    case "ctl":
      return "ctrl"
    case "alt":
    case "option":
      return "alt"
    case "shift":
      return "shift"
    case "cmd":
    case "command":
    case "meta":
    case "super":
    case "win":
    case "windows":
      return "meta"
    case "altgraph":
    case "alt-graph":
      return "altGraph"
    default:
      return undefined
  }
}

const signatureFor = (
  key: string,
  modifiers: Omit<NormalizedKeyboardBinding, "key" | "signature">
): string => {
  const prefix = modifiers.altGraph
    ? ["AltGraph"]
    : [
        modifiers.ctrl && "Ctrl",
        modifiers.alt && "Alt",
        modifiers.shift && "Shift",
        modifiers.meta && "Meta",
      ].filter((value): value is string => Boolean(value))
  return [...prefix, key].join("+")
}

export function normalizeBinding(
  input: KeyboardBindingInput
): NormalizedKeyboardBinding {
  const pieces = typeof input === "string" ? input.split("+") : []
  const fromString =
    typeof input === "string"
      ? pieces.reduce(
          (result, piece, index) => {
            const modifier = modifierName(piece)
            if (modifier && index < pieces.length - 1) {
              result[modifier] = true
            } else if (piece.trim()) {
              result.key = piece
            }
            return result
          },
          {
            key: "",
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
            altGraph: false,
          } as {
            key: string
            ctrl: boolean
            alt: boolean
            shift: boolean
            meta: boolean
            altGraph: boolean
          }
        )
      : {
          key: input.key,
          ctrl: input.ctrl ?? false,
          alt: input.alt ?? false,
          shift: input.shift ?? false,
          meta: input.meta ?? false,
          altGraph: input.altGraph ?? false,
        }

  if (!fromString.key)
    throw new TypeError(`Keyboard binding is missing a key: ${String(input)}`)
  const key = normalizeKey(fromString.key)
  const altGraph = fromString.altGraph
  const normalized = {
    key,
    ctrl: altGraph ? false : fromString.ctrl,
    alt: altGraph ? false : fromString.alt,
    shift: fromString.shift,
    meta: fromString.meta,
    altGraph,
  }
  return { ...normalized, signature: signatureFor(key, normalized) }
}

export const bindingSignature = (
  binding: KeyboardBindingInput | NormalizedKeyboardBinding
): string =>
  typeof binding === "object" && binding !== null && "signature" in binding
    ? binding.signature
    : normalizeBinding(binding).signature

export function normalizeBindingOverrides(
  overrides: KeyboardBindingOverrides
): Readonly<
  Record<KeyboardActionId, readonly NormalizedKeyboardBinding[] | null>
> {
  const result: Record<
    KeyboardActionId,
    readonly NormalizedKeyboardBinding[] | null
  > = {}
  for (const [actionId, value] of Object.entries(overrides)) {
    if (value === null) {
      result[actionId] = null
      continue
    }
    const list = Array.isArray(value) ? value : [value]
    result[actionId] = list.map(normalizeBinding)
  }
  return result
}

export type EffectiveKeyboardAction = Omit<
  KeyboardActionDefinition,
  "bindings"
> & {
  readonly bindings: readonly NormalizedKeyboardBinding[]
}

export function resolveEffectiveBindings(
  catalog: readonly KeyboardActionDefinition[] = KEYBOARD_ACTION_CATALOG,
  overrides:
    | KeyboardBindingOverrides
    | Readonly<Record<string, readonly NormalizedKeyboardBinding[] | null>> = {}
): readonly EffectiveKeyboardAction[] {
  const normalizedOverrides = normalizeBindingOverridesIfNeeded(overrides)
  return catalog.map((action) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(
      normalizedOverrides,
      action.id
    )
    const override = normalizedOverrides[action.id]
    return {
      ...action,
      bindings: hasOverride
        ? (override ?? [])
        : action.bindings.map(normalizeBinding),
    }
  })
}

function normalizeBindingOverridesIfNeeded(
  overrides:
    | KeyboardBindingOverrides
    | Readonly<Record<string, readonly NormalizedKeyboardBinding[] | null>>
): Readonly<Record<string, readonly NormalizedKeyboardBinding[] | null>> {
  const result: Record<string, readonly NormalizedKeyboardBinding[] | null> = {}
  for (const [actionId, value] of Object.entries(overrides)) {
    if (value === null) {
      result[actionId] = null
    } else if (
      Array.isArray(value) &&
      value.every(
        (binding) =>
          typeof binding === "object" &&
          binding !== null &&
          "signature" in binding
      )
    ) {
      result[actionId] = value as readonly NormalizedKeyboardBinding[]
    } else {
      const list = Array.isArray(value) ? value : [value]
      result[actionId] = list.map(normalizeBinding)
    }
  }
  return result
}

export type KeyboardEventLike = {
  /** Browser and automation events may omit key or expose a malformed value. */
  readonly key?: unknown
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
  readonly metaKey?: boolean
  readonly isComposing?: boolean
  /** Chromium/WebKit expose this during an IME keypress. */
  readonly keyCode?: number
  readonly defaultPrevented?: boolean
  readonly target?: EventTarget | null
  readonly currentTarget?: EventTarget | null
  readonly nativeEvent?: {
    readonly isComposing?: boolean
    /** Chromium/WebKit expose this during an IME keypress. */
    readonly keyCode?: number
    getModifierState?(keyArg: string): boolean
  }
  getModifierState?(keyArg: string): boolean
  preventDefault: () => void
}

export type KeyboardEventSafetyReason =
  "default-prevented" | "composing" | "dead-key" | "alt-graph"

/**
 * Returns why a browser key event must remain native, or undefined when a
 * shortcut consumer may inspect it. Capture UIs and the global dispatcher
 * share this guard so IME, dead-key, and AltGraph input is never swallowed.
 */
export function keyboardEventSafetyReason(
  event: KeyboardEventLike
): KeyboardEventSafetyReason | undefined {
  if (event.defaultPrevented) return "default-prevented"
  if (
    event.isComposing ||
    event.nativeEvent?.isComposing ||
    event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229
  )
    return "composing"
  if (event.key === "Dead") return "dead-key"
  if (
    event.getModifierState?.("AltGraph") === true ||
    event.nativeEvent?.getModifierState?.("AltGraph") === true
  )
    return "alt-graph"
  return undefined
}

export function normalizeKeyboardEvent(
  event: KeyboardEventLike
): NormalizedKeyboardBinding | undefined {
  const key = event.key
  if (
    typeof key !== "string" ||
    (key !== " " && key.trim() === "") ||
    key.trim().toLowerCase() === "unidentified" ||
    modifierName(key) !== undefined
  ) {
    return undefined
  }

  const altGraph =
    event.getModifierState?.("AltGraph") === true ||
    event.nativeEvent?.getModifierState?.("AltGraph") === true
  try {
    return normalizeBinding({
      key,
      ctrl: event.ctrlKey === true,
      alt: event.altKey === true,
      shift: event.shiftKey === true,
      meta: event.metaKey === true,
      altGraph,
    })
  } catch {
    return undefined
  }
}

/** True for controls where browser editing and IME behavior must remain native. */
export function isNativeEditableTarget(
  target: EventTarget | null | undefined
): boolean {
  if (!target || typeof target !== "object") return false
  const element = target as {
    tagName?: string
    isContentEditable?: boolean
    contentEditable?: string
  }
  const tagName = element.tagName?.toUpperCase()
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    element.isContentEditable === true ||
    element.contentEditable === "true" ||
    element.contentEditable === "plaintext-only"
  )
}
