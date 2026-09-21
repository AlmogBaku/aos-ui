"use client"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"

export type SessionDeleteDialogCopy = {
  title: string
  description: string
  confirm: string
  cancel: string
}

export function SessionDeleteDialog({
  open,
  locale,
  copy,
  sessionTitle,
  finalFocus,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  locale: Locale
  copy: SessionDeleteDialogCopy
  sessionTitle: string
  finalFocus?: () => HTMLElement | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        size="sm"
        dir={getLocaleDirection(locale)}
        finalFocus={finalFocus}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <bdi className="text-sm font-medium">{sessionTitle}</bdi>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {copy.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
