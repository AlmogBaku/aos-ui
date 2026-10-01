import { createContext, useContext, type ReactNode } from "react"
import { createPortal } from "react-dom"

/** The view's header row, where a preview's controls sit beside its actions. */
export const ToolbarSlot = createContext<HTMLElement | null>(null)

/**
 * A preview's controls: in the view's header when it offers a slot, so they
 * share a line with its actions, and otherwise in place.
 */
export function Toolbar({ children }: { children: ReactNode }) {
  const slot = useContext(ToolbarSlot)
  const row = (
    <div className="flex flex-wrap items-center gap-1">{children}</div>
  )
  return slot ? createPortal(row, slot) : row
}
