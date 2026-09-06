"use client"

import { Search } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { Locale } from "@/lib/i18n/config"

export type KeyboardCommand = {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly binding?: string
  readonly unavailableReason?: string
  readonly onRun?: () => void | Promise<unknown>
}

export function CommandPalette({
  open,
  locale,
  commands,
  onOpenChange,
}: {
  open: boolean
  locale: Locale
  commands: readonly KeyboardCommand[]
  onOpenChange: (open: boolean) => void
}) {
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) {
      return
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale)
    if (!normalized) return commands
    return commands.filter((command) =>
      `${command.title} ${command.description ?? ""} ${command.unavailableReason ?? ""}`
        .toLocaleLowerCase(locale)
        .includes(normalized)
    )
  }, [commands, locale, query])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(80svh,42rem)] max-w-xl overflow-hidden p-0"
        aria-describedby="keyboard-command-description"
      >
        <DialogHeader className="border-b px-4 py-4 pe-12">
          <DialogTitle>{locale === "he" ? "פקודות" : "Commands"}</DialogTitle>
          <DialogDescription id="keyboard-command-description">
            {locale === "he"
              ? "חיפוש פעולות זמינות"
              : "Search available actions"}
          </DialogDescription>
        </DialogHeader>
        <div className="border-b px-4 py-3">
          <label className="sr-only" htmlFor="keyboard-command-search">
            {locale === "he" ? "חיפוש פקודות" : "Search commands"}
          </label>
          <div className="flex items-center gap-2 rounded-lg border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
            <Search
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              id="keyboard-command-search"
              className="min-h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
              type="search"
              role="searchbox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                locale === "he" ? "חיפוש פקודות…" : "Search commands…"
              }
            />
          </div>
        </div>
        <div
          className="max-h-[52svh] overflow-y-auto p-2"
          aria-label={locale === "he" ? "פקודות" : "Commands"}
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {locale === "he" ? "לא נמצאו פקודות" : "No commands found"}
            </p>
          ) : (
            filtered.map((command) => {
              const unavailable = Boolean(command.unavailableReason)
              const unavailableId = `keyboard-command-${command.id.replace(/[^a-z0-9_-]/gi, "-")}-unavailable`
              return (
                <button
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  key={command.id}
                  type="button"
                  disabled={unavailable}
                  aria-disabled={unavailable || undefined}
                  aria-label={command.title}
                  aria-describedby={unavailable ? unavailableId : undefined}
                  onClick={() => {
                    if (unavailable) return
                    void command.onRun?.()
                    onOpenChange(false)
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {command.title}
                    </span>
                    {command.description ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {command.description}
                      </span>
                    ) : null}
                    {command.unavailableReason ? (
                      <span
                        id={unavailableId}
                        className="mt-0.5 block text-xs text-muted-foreground"
                      >
                        {command.unavailableReason}
                      </span>
                    ) : null}
                  </span>
                  {command.binding ? (
                    <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {command.binding}
                    </kbd>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
