import {
  KEYBOARD_ACTION_CATALOG,
  type KeyboardActionDefinition,
  type KeyboardActionId,
} from "./actions"
import {
  isNativeEditableTarget,
  keyboardEventSafetyReason,
  normalizeKeyboardEvent,
  resolveEffectiveBindings,
  type EffectiveKeyboardAction,
  type KeyboardBindingOverrides,
  type KeyboardEventLike,
  type KeyboardEventSafetyReason,
  type NormalizedKeyboardBinding,
} from "./bindings"

export type KeyboardActionHandler = (
  actionId: KeyboardActionId,
  event: KeyboardEventLike,
  context: KeyboardDispatchContext
) => boolean | void

export type KeyboardActionOwner = {
  readonly id: string
  readonly priority?: number
  readonly actions?: readonly KeyboardActionId[] | ReadonlySet<KeyboardActionId>
  readonly canHandle?: KeyboardActionHandler
  readonly handle: KeyboardActionHandler
}

export type KeyboardDispatchContext = {
  readonly action: EffectiveKeyboardAction
  readonly binding: NormalizedKeyboardBinding
}

export type KeyboardDispatchResult = {
  readonly handled: boolean
  readonly actionId?: KeyboardActionId
  readonly ownerId?: string
  readonly binding?: NormalizedKeyboardBinding
  readonly reason?:
    KeyboardEventSafetyReason | "editable" | "unbound" | "unowned"
}

export type KeyboardDispatcherOptions = {
  readonly catalog?: readonly KeyboardActionDefinition[]
  readonly overrides?: KeyboardBindingOverrides
  readonly owners?: readonly KeyboardActionOwner[]
}

export type KeyboardDispatcher = {
  readonly dispatch: (event: KeyboardEventLike) => KeyboardDispatchResult
  readonly registerOwner: (owner: KeyboardActionOwner) => () => void
}

export function createKeyboardDispatcher(
  options: KeyboardDispatcherOptions = {}
): KeyboardDispatcher {
  const actions = resolveEffectiveBindings(
    options.catalog ?? KEYBOARD_ACTION_CATALOG,
    options.overrides ?? {}
  )
  const bySignature = new Map<string, EffectiveKeyboardAction[]>()
  for (const action of actions) {
    for (const binding of action.bindings) {
      const entries = bySignature.get(binding.signature) ?? []
      entries.push(action)
      bySignature.set(binding.signature, entries)
    }
  }

  const owners = [...(options.owners ?? [])]
  const orderedOwners = () =>
    owners
      .map((owner, index) => ({ owner, index }))
      .sort(
        (left, right) =>
          (right.owner.priority ?? 0) - (left.owner.priority ?? 0) ||
          left.index - right.index
      )
      .map(({ owner }) => owner)

  const registerOwner = (owner: KeyboardActionOwner): (() => void) => {
    owners.push(owner)
    return () => {
      const index = owners.indexOf(owner)
      if (index >= 0) owners.splice(index, 1)
    }
  }

  const dispatch = (event: KeyboardEventLike): KeyboardDispatchResult => {
    const safetyReason = keyboardEventSafetyReason(event)
    if (safetyReason) return { handled: false, reason: safetyReason }

    const binding = normalizeKeyboardEvent(event)
    if (!binding) return { handled: false, reason: "unbound" }
    const candidates = bySignature.get(binding.signature)
    if (!candidates || candidates.length === 0) {
      return { handled: false, binding, reason: "unbound" }
    }

    const editable = isNativeEditableTarget(event.target ?? event.currentTarget)
    let sawOwnedCandidate = false
    for (const action of candidates) {
      if (editable && !action.allowInEditable) continue
      const context = { action, binding }
      for (const owner of orderedOwners()) {
        if (owner.actions) {
          const owns =
            "has" in owner.actions
              ? owner.actions.has(action.id)
              : owner.actions.includes(action.id)
          if (!owns) continue
        }
        sawOwnedCandidate = true
        if (
          owner.canHandle &&
          owner.canHandle(action.id, event, context) === false
        )
          continue
        // A handler may return void for the common “claimed” case. Returning
        // false explicitly yields ownership to the next eligible owner.
        if (owner.handle(action.id, event, context) === false) continue
        event.preventDefault()
        return {
          handled: true,
          actionId: action.id,
          ownerId: owner.id,
          binding,
        }
      }
    }
    return {
      handled: false,
      binding,
      reason: sawOwnedCandidate ? "unowned" : editable ? "editable" : "unowned",
    }
  }

  return { dispatch, registerOwner }
}

export const KeyboardActionDispatcher = createKeyboardDispatcher
