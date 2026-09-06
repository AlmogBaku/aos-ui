"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  resolveEffectiveBindings,
  type KeyboardActionId,
  type KeyboardBindingInput,
  type KeyboardBindingOverrides,
  type KeyboardLocale,
} from "@/lib/keyboard"

import { KEYBOARD_UI_CATALOG } from "./keyboard-actions"
import {
  KEYBOARD_OVERRIDES_EVENT,
  readKeyboardOverrides,
  writeKeyboardOverrides,
} from "./keyboard-settings"

export function useKeyboardSettings(locale: KeyboardLocale) {
  void locale
  const [overrides, setOverrides] = useState<KeyboardBindingOverrides>(() =>
    readKeyboardOverrides()
  )

  useEffect(() => {
    const update = () => setOverrides(readKeyboardOverrides())
    window.addEventListener("storage", update)
    window.addEventListener(KEYBOARD_OVERRIDES_EVENT, update)
    return () => {
      window.removeEventListener("storage", update)
      window.removeEventListener(KEYBOARD_OVERRIDES_EVENT, update)
    }
  }, [])

  const effectiveBindings = useMemo(
    () => resolveEffectiveBindings(KEYBOARD_UI_CATALOG, overrides),
    [overrides]
  )

  const setBinding = useCallback(
    (actionId: KeyboardActionId, binding: KeyboardBindingInput | null) => {
      setOverrides((current) => {
        const next = { ...current, [actionId]: binding }
        writeKeyboardOverrides(next)
        return next
      })
    },
    []
  )

  const resetBinding = useCallback((actionId: KeyboardActionId) => {
    setOverrides((current) => {
      const next = { ...current }
      delete next[actionId]
      writeKeyboardOverrides(next)
      return next
    })
  }, [])

  const resetAll = useCallback(() => {
    setOverrides({})
    writeKeyboardOverrides({})
  }, [])

  return {
    overrides,
    effectiveBindings,
    setBinding,
    resetBinding,
    resetAll,
  }
}
