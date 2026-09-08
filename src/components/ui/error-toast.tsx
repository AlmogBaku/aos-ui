import { AlertCircle, X } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"

/** Persistent, non-modal error feedback. The owner clears resolved errors. */
export function ErrorToast({
  title,
  message,
  locale,
  onDismiss,
  actions,
}: {
  title: string
  message: string
  locale: Locale
  onDismiss: () => void
  actions?: ReactNode
}) {
  return (
    <div
      data-slot="error-toast"
      role="alert"
      aria-atomic="true"
      dir={locale === "he" ? "rtl" : "ltr"}
      className="fixed end-4 bottom-[calc(7rem+env(safe-area-inset-bottom))] z-[100] flex w-[calc(100%-2rem)] max-w-sm items-start gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg lg:bottom-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-destructive"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 max-h-40 overflow-y-auto text-xs break-words text-muted-foreground">
          {message}
        </p>
        {actions ? (
          <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
        ) : null}
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={locale === "he" ? "סגירת הודעה" : "Dismiss notification"}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  )
}
