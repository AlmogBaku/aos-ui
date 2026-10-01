import { useLayoutEffect, useState, type RefObject } from "react"

/** The space a preview may take, in CSS pixels. */
export type Room = { width: number; height: number }

/** The least height a preview keeps, however short the window. */
const MIN_HEIGHT = 240

function same(a: Room, b: Room) {
  return a.width === b.width && a.height === b.height
}

/**
 * The room below the view's header that a preview may fill without the view
 * scrolling: down to the bottom of `root`, which does not depend on the
 * preview, so filling it never moves it.
 */
export function useRoom(
  root: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  ready: boolean
) {
  const [room, setRoom] = useState<Room>({ width: 0, height: MIN_HEIGHT })
  useLayoutEffect(() => {
    const outer = root.current
    const inner = box.current
    if (!ready || !outer || !inner) return
    const measure = () => {
      const bottom = outer.getBoundingClientRect().bottom
      const padding = Number.parseFloat(getComputedStyle(outer).paddingBottom)
      const next = {
        width: Math.floor(inner.clientWidth),
        height: Math.max(
          MIN_HEIGHT,
          Math.floor(
            bottom - inner.getBoundingClientRect().top - (padding || 0)
          )
        ),
      }
      setRoom((previous) => (same(previous, next) ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    // The header above the preview may wrap as the view narrows.
    for (const element of [outer, ...outer.children]) observer.observe(element)
    return () => observer.disconnect()
  }, [root, box, ready])
  return room
}
