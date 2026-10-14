"use client"

import { useId } from "react"

import type { EffectiveKeyboardAction, KeyboardLocale } from "@/lib/keyboard"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import type { WorkspaceCommand } from "@/components/workspace/workspace-commands"

import { formatKeyboardBindings } from "./keyboard-settings"

export function KeyboardReference({
  open,
  locale,
  actions,
  commands = [],
  onOpenChange,
}: {
  open: boolean
  locale: KeyboardLocale
  actions: readonly EffectiveKeyboardAction[]
  /** The workspace's slash commands, listed after the shortcuts. */
  commands?: readonly Pick<
    WorkspaceCommand,
    "id" | "title" | "names" | "argument"
  >[]
  onOpenChange: (open: boolean) => void
}) {
  const title = locale === "he" ? "מקשי קיצור" : "Keyboard reference"
  const commandsHeadingId = useId()
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
        {commands.length > 0 ? (
          <section className="grid gap-1.5" aria-labelledby={commandsHeadingId}>
            <h3
              id={commandsHeadingId}
              className="px-2 pt-2 text-sm font-medium text-muted-foreground"
            >
              {locale === "he" ? "פקודות קו נטוי" : "Slash commands"}
            </h3>
            {commands.map((command) => (
              <div
                className="flex items-center gap-3 rounded-lg px-2 py-2"
                key={command.id}
              >
                <span className="min-w-0 flex-1 text-sm">{command.title}</span>
                <code className="text-xs text-muted-foreground" dir="ltr">
                  {[`/${command.names[0]}`, command.argument?.hint]
                    .filter(Boolean)
                    .join(" ")}
                </code>
              </div>
            ))}
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
