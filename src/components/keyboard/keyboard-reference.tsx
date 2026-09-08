"use client"

import type { EffectiveKeyboardAction, KeyboardLocale } from "@/lib/keyboard"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { formatKeyboardBindings } from "./keyboard-settings"

export function KeyboardReference({
  open,
  locale,
  actions,
  onOpenChange,
}: {
  open: boolean
  locale: KeyboardLocale
  actions: readonly EffectiveKeyboardAction[]
  onOpenChange: (open: boolean) => void
}) {
  const title = locale === "he" ? "מקשי קיצור" : "Keyboard reference"
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(80svh,42rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {locale === "he"
              ? "הקיצורים הפעילים בסביבת העבודה"
              : "Active shortcuts in this workspace"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5" aria-label={title}>
          {actions.map((action) => (
            <div
              className="flex items-center gap-3 rounded-lg px-2 py-2"
              key={action.id}
            >
              <span className="min-w-0 flex-1 text-sm">
                {action.title[locale]}
              </span>
              <span className="text-xs text-muted-foreground">
                {action.bindings.length
                  ? formatKeyboardBindings(action.bindings, locale).join(" · ")
                  : locale === "he"
                    ? "ללא קיצור"
                    : "Unbound"}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
