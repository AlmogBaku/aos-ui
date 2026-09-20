"use client"

import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"

/** Providers reject unbounded titles, so the composer stops well before that. */
export const sessionTitleMaxLength = 4096

export type SessionRenameDialogCopy = {
  title: string
  label: string
  save: string
  cancel: string
}

export function SessionRenameDialog({
  open,
  locale,
  copy,
  sessionTitle,
  finalFocus,
  onOpenChange,
  onSave,
}: {
  open: boolean
  locale: Locale
  copy: SessionRenameDialogCopy
  sessionTitle: string
  finalFocus?: () => HTMLElement | null
  onOpenChange: (open: boolean) => void
  onSave: (title: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(sessionTitle)
  const trimmed = value.trim()
  const valid = trimmed.length > 0 && trimmed.length <= sessionTitleMaxLength

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dir={getLocaleDirection(locale)}
        showCloseButton={false}
        className="gap-3 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none"
        overlayClassName="motion-reduce:data-closed:animate-none motion-reduce:data-open:animate-none"
        initialFocus={() => {
          // Selecting before focus keeps the whole title replaceable.
          inputRef.current?.select()
          return inputRef.current
        }}
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) onSave(trimmed)
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">{copy.label}</span>
            <Input
              ref={inputRef}
              value={value}
              maxLength={sessionTitleMaxLength}
              aria-invalid={valid ? undefined : true}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {copy.cancel}
            </Button>
            <Button type="submit" disabled={!valid}>
              {copy.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
