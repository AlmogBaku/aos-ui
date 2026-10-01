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
 * scrolling: down to the bottom of `root`, or to `limit` pixels below its top
 * when the host caps the view's height. Neither bound depends on the preview,
 * so filling it never moves it.
 */
export function useRoom(
  root: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  limit: number | undefined,
  ready: boolean
) {
  const [room, setRoom] = useState<Room>({ width: 0, height: MIN_HEIGHT })
  useLayoutEffect(() => {
    const outer = root.current
    const inner = box.current
    if (!ready || !outer || !inner) return
    const measure = () => {
      const top = outer.getBoundingClientRect().top
      const bottom =
        limit === undefined ? outer.getBoundingClientRect().bottom : top + limit
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
    observer.observe(outer)
    return () => observer.disconnect()
  }, [root, box, limit, ready])
  return room
}
