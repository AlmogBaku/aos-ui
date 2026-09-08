"use client"

import { useMemo, useState, type KeyboardEvent } from "react"

import {
  keyboardEventSafetyReason,
  normalizeBinding,
  normalizeKeyboardEvent,
  type EffectiveKeyboardAction,
  type KeyboardActionId,
  type KeyboardBindingInput,
  type KeyboardLocale,
} from "@/lib/keyboard"

import {
  formatKeyboardBindings,
  validateKeyboardBinding,
} from "./keyboard-settings"

type SettingsProps = {
  locale: KeyboardLocale
  effectiveBindings: readonly EffectiveKeyboardAction[]
  setBinding: (
    actionId: KeyboardActionId,
    binding: KeyboardBindingInput | null
  ) => void
  resetBinding: (actionId: KeyboardActionId) => void
  resetAll: () => void
}

const copy = {
  en: {
    essentials: "Essentials",
    search: "Search shortcuts",
    editing: "Editing keys (fixed)",
    editingDescription:
      "Browser and text editing keys stay available for native editing.",
    workspace: "Workspace",
    commands: "Commands",
    settings: "Settings",
    unbound: "Unbound",
    capture: "Press a key combination…",
    set: "Set shortcut",
    unbind: "Unbind",
    reset: "Reset",
    resetAll: "Reset all shortcuts",
    reserved: "That shortcut is reserved by the browser.",
    conflict: "That shortcut is already assigned.",
    invalid: "That shortcut is not valid.",
  },
  he: {
    essentials: "קיצורים חיוניים",
    search: "חיפוש קיצורים",
    editing: "מקשי עריכה (קבועים)",
    editingDescription: "מקשי הדפדפן והעריכה נשארים זמינים לעריכה רגילה.",
    workspace: "סביבת העבודה",
    commands: "פקודות",
    settings: "הגדרות",
    unbound: "ללא קיצור",
    capture: "לחצו על צירוף מקשים…",
    set: "הגדרת קיצור",
    unbind: "הסרת קיצור",
    reset: "איפוס",
    resetAll: "איפוס כל הקיצורים",
    reserved: "הקיצור שמור לדפדפן.",
    conflict: "הקיצור כבר משויך לפעולה אחרת.",
    invalid: "הקיצור אינו תקין.",
  },
} as const

function eventToInput(event: KeyboardEvent): string | null {
  if (keyboardEventSafetyReason(event)) return null
  const binding = normalizeKeyboardEvent(event)
  if (!binding) return null
  const modifiers: string[] = []
  if (binding.altGraph) modifiers.push("AltGraph")
  else {
    if (binding.ctrl) modifiers.push("Ctrl")
    if (binding.alt) modifiers.push("Alt")
    if (binding.shift) modifiers.push("Shift")
    if (binding.meta) modifiers.push("Meta")
  }
  const input = [...modifiers, binding.key].join("+")
  try {
    normalizeBinding(input)
    return input
  } catch {
    return null
  }
}

export function KeyboardShortcutsSettings({
  locale,
  effectiveBindings,
  setBinding,
  resetBinding,
  resetAll,
}: SettingsProps) {
  const labels = copy[locale]
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<
    "all" | "workspace" | "commands" | "settings"
  >("all")
  const [capturing, setCapturing] = useState<KeyboardActionId | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(
    null
  )
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale)
    return effectiveBindings.filter((action) => {
      const inCategory =
        category === "all" ||
        action.scope === category ||
        (category === "workspace" && action.scope === "global")
      const searchable =
        `${action.title[locale]} ${action.description?.[locale] ?? ""}`.toLocaleLowerCase(
          locale
        )
      return inCategory && (!normalized || searchable.includes(normalized))
    })
  }, [category, effectiveBindings, locale, query])

  return (
    <section
      className="flex min-h-0 flex-col gap-4"
      aria-label={locale === "he" ? "קיצורי מקלדת" : "Keyboard shortcuts"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="me-auto text-sm">{labels.essentials}</strong>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          onClick={resetAll}
        >
          {labels.resetAll}
        </button>
      </div>
      <label className="sr-only" htmlFor="keyboard-settings-search">
        {labels.search}
      </label>
      <input
        id="keyboard-settings-search"
        role="searchbox"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={labels.search}
        className="min-h-10 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label={locale === "he" ? "קטגוריות" : "Categories"}
      >
        {(["all", "workspace", "commands", "settings"] as const).map(
          (value) => {
            const label = value === "all" ? labels.essentials : labels[value]
            return (
              <button
                type="button"
                key={value}
                aria-pressed={category === value}
                className="rounded-md px-2.5 py-1.5 text-xs hover:bg-muted aria-pressed:bg-secondary"
                onClick={() => setCategory(value)}
              >
                {label}
              </button>
            )
          }
        )}
      </div>
      <div className="min-h-0 overflow-y-auto rounded-lg border" role="list">
        {visible.map((action) => {
          const isCapturing = capturing === action.id
          const actionError = error?.id === action.id ? error.message : null
          const bindings = formatKeyboardBindings(action.bindings, locale)
          return (
            <div
              className="flex flex-wrap items-center gap-3 border-b p-3 last:border-b-0"
              key={action.id}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{action.title[locale]}</p>
                {action.description?.[locale] ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {action.description[locale]}
                  </p>
                ) : null}
                {actionError ? (
                  <p className="mt-1 text-xs text-destructive" role="alert">
                    {actionError}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                {bindings.length > 0 ? (
                  bindings.map((binding, index) => (
                    <kbd
                      key={`${binding}-${index}`}
                      className="rounded border bg-muted px-1.5 py-0.5 text-xs"
                    >
                      {binding}
                    </kbd>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {labels.unbound}
                  </span>
                )}
                <button
                  type="button"
                  className="rounded-md px-2 py-1.5 text-xs hover:bg-muted"
                  aria-label={`${labels.set}: ${action.title[locale]}`}
                  onClick={() => {
                    setCapturing(action.id)
                    setError(null)
                  }}
                  onKeyDown={(event) => {
                    if (!isCapturing) return
                    if (keyboardEventSafetyReason(event)) return
                    if (event.key === "Escape") {
                      event.preventDefault()
                      setCapturing(null)
                      return
                    }
                    const input = eventToInput(event)
                    if (!input) return
                    event.preventDefault()
                    const result = validateKeyboardBinding(
                      action.id,
                      input,
                      effectiveBindings
                    )
                    if (!result.valid) {
                      setError({
                        id: action.id,
                        message: labels[result.reason],
                      })
                      return
                    }
                    setBinding(action.id, input)
                    setError(null)
                    setCapturing(null)
                  }}
                >
                  {isCapturing ? labels.capture : labels.set}
                </button>
                <button
                  type="button"
                  className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                  onClick={() => setBinding(action.id, null)}
                >
                  {labels.unbind}
                </button>
                <button
                  type="button"
                  className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                  onClick={() => resetBinding(action.id)}
                >
                  {labels.reset}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="rounded-lg border border-dashed p-3">
        <p className="text-sm font-medium">{labels.editing}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {labels.editingDescription}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Tab · Enter · Escape · Arrow keys
        </p>
      </div>
    </section>
  )
}
