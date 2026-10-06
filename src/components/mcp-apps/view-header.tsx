import { XIcon } from "lucide-react"
import type { Ref } from "react"

import { Button } from "@/components/ui/button"

/**
 * The bar above a view in the side panel and in full screen: its name, the
 * type of the file it shows, and the control that closes it.
 */
export function ViewHeader({
  title,
  detail,
  closeLabel,
  closeRef,
  onClose,
}: {
  title: string
  detail?: string | undefined
  closeLabel: string
  closeRef?: Ref<HTMLButtonElement>
  onClose: () => void
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        {/* The name keeps its own direction; the heading aligns with the page. */}
        <h2 className="truncate text-base font-medium">
          <bdi>{title}</bdi>
        </h2>
        {detail ? (
          <p className="truncate text-sm text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      <Button
        ref={closeRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={closeLabel}
        onClick={onClose}
        className="[@media(pointer:coarse)]:size-11"
      >
        <XIcon />
      </Button>
    </header>
  )
}
