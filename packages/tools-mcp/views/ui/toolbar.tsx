import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"

/** The view's header row, where a preview's controls sit beside its actions. */
export const ToolbarSlot = createContext<HTMLElement | null>(null)

/**
 * Whether the view is as narrow as a phone, where its controls fold to fit
 * one row.
 */
export const Compact = createContext(false)

/** The widest a view is that counts as compact, in CSS pixels. */
const COMPACT_WIDTH = 480

/**
 * Whether `root` is compact. One not laid out yet measures no width and keeps
 * the wide controls.
 */
export function useCompact(root: RefObject<HTMLElement | null>) {
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const element = root.current!
    const measure = () => {
      const width = element.clientWidth
      setCompact(width > 0 && width < COMPACT_WIDTH)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [root])
  return compact
}

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
