import { Shrink, ZoomIn, ZoomOut } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"

import type { ViewLabels } from "../locale"
import { cn } from "../ui/cn"
import { IconButton } from "../ui/icon-button"
import { Toolbar } from "../ui/toolbar"
import type { Room } from "./room"

type Labels = ViewLabels["artifact"]

/** The space the content fits in before it is zoomed, in CSS pixels. */
export type Space = { width: number; height: number }

/** How far past fitted the content zooms; it never shrinks below fitted. */
export const MAX_ZOOM = 8

/** How much one press of a zoom key or button zooms. */
const STEP = 1.25

/** The most one wheel event zooms, so a mouse wheel's notch is one step. */
const WHEEL_DELTA = 25

const clamp = (zoom: number) => Math.min(Math.max(zoom, 1), MAX_ZOOM)

const ZOOM_KEYS: Partial<Record<string, (zoom: number) => number>> = {
  "+": (zoom) => zoom * STEP,
  "=": (zoom) => zoom * STEP,
  "-": (zoom) => zoom / STEP,
  "0": () => 1,
}

/** Where the reader turns a paged document. */
export type Turn = "previous" | "next" | "first" | "last"

/** How far an arrow key scrolls, in CSS pixels; a page key scrolls a screen less this. */
const ARROW_STEP = 40

/**
 * Each key that scrolls the content: down it or across it, toward its end (1)
 * or its start (-1).
 */
const SCROLL_KEYS: Partial<Record<string, ["y" | "x", 1 | -1]>> = {
  ArrowDown: ["y", 1],
  PageDown: ["y", 1],
  " ": ["y", 1],
  ArrowUp: ["y", -1],
  PageUp: ["y", -1],
  ArrowRight: ["x", 1],
  ArrowLeft: ["x", -1],
}

/** Where a key belongs to the control it is pressed in, not the content. */
const OWN_KEYS = "input, textarea, select, [contenteditable], nav"

/** Where Space and Enter press the control rather than scroll. */
const PRESSABLE = "a, button, summary, [role='button']"

/**
 * What a key does to the content in `box`: scroll it, or, with the content
 * already at that edge, turn to the next or previous page. Across the content,
 * the arrow toward the next page follows the reading direction, as the paging
 * buttons do. Home and End turn to the first and last page.
 */
export function keyAction(
  event: Pick<KeyboardEvent, "key" | "shiftKey">,
  box: Element
): { scroll: { top: number; left: number } } | { turn: Turn } | undefined {
  if (event.key === "Home") return { turn: "first" }
  if (event.key === "End") return { turn: "last" }
  const scroll = SCROLL_KEYS[event.key]
  if (!scroll) return undefined
  const [axis, toward] = scroll
  const way = event.key === " " && event.shiftKey ? -1 : toward
  const down = axis === "y"
  const at = down ? box.scrollTop : box.scrollLeft
  const end = down
    ? box.scrollHeight - box.clientHeight
    : box.scrollWidth - box.clientWidth
  if (way > 0 ? at >= end - 1 : at <= 0) {
    const rtl = !down && document.documentElement.dir === "rtl"
    return { turn: way > 0 !== rtl ? "next" : "previous" }
  }
  const step = event.key.startsWith("Arrow")
    ? ARROW_STEP
    : Math.max(box.clientHeight - ARROW_STEP, ARROW_STEP)
  return {
    scroll: { top: down ? way * step : 0, left: down ? 0 : way * step },
  }
}

type Point = { x: number; y: number }

/** A point on the screen and where it falls across the content, 0 to 1. */
type Anchor = Point & { across: number; down: number }

function distance([a, b]: Point[]) {
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
}

function middle([a, b]: Point[]): Point | undefined {
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : undefined
}

/**
 * Content fitted to the room, with zoom controls among the view's. A pinch, a
 * trackpad pinch or Ctrl with the wheel, the zoom keys (+, -, and 0 to fit),
 * or the controls zoom it about the point they act at; zoomed in, it scrolls
 * to pan. The arrow, page, and space keys scroll it, and `onTurn` takes those
 * that would scroll past its edge, with Home and End, and answers whether it
 * turned. The keys work from
 * anywhere in the view but a field or the sidebar, unless a control used the
 * key. `children` lays the content out at a zoom in the space it fits. Unless
 * `fill` holds, the pane is only as tall as its fitted content. A new `start`
 * scrolls back to the content's top, or to its foot when the reader scrolled
 * up into it.
 */
export function ZoomPane({
  room,
  label,
  labels,
  controls,
  aside,
  fill = false,
  start,
  onTurn,
  children,
}: {
  room: Room
  label: string
  labels: Labels
  controls?: ReactNode
  aside?: ReactNode
  fill?: boolean
  start?: unknown
  onTurn?: (to: Turn) => boolean
  children: (space: Space, zoom: number) => ReactNode
}) {
  const pane = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [space, setSpace] = useState<Space>({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const current = useRef(zoom)
  const anchor = useRef<Anchor | undefined>(undefined)

  // The space below anything above the content and beside any aside, neither
  // of which moves as the content grows.
  useLayoutEffect(() => {
    const measure = () => {
      const width = box.current!.clientWidth
      const height = Math.floor(
        room.height -
          (body.current!.getBoundingClientRect().top -
            pane.current!.getBoundingClientRect().top)
      )
      setSpace((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pane.current!)
    observer.observe(box.current!)
    return () => observer.disconnect()
  }, [room.height])

  // Zooming keeps the anchor's point of the content under it.
  useLayoutEffect(() => {
    current.current = zoom
    const at = anchor.current
    const content = box.current?.firstElementChild
    anchor.current = undefined
    if (!at || !content) return
    const rect = content.getBoundingClientRect()
    box.current!.scrollLeft += rect.left + at.across * rect.width - at.x
    box.current!.scrollTop += rect.top + at.down * rect.height - at.y
  }, [zoom])

  // Scrolling back past a page's top lands at the foot of the one before.
  const fromBelow = useRef(false)
  useLayoutEffect(() => {
    const element = box.current!
    element.scrollTop = fromBelow.current ? element.scrollHeight : 0
    fromBelow.current = false
  }, [start])

  const zoomTo = useCallback((next: number, at?: Point) => {
    const element = box.current
    const content = element?.firstElementChild
    if (element && content) {
      const view = element.getBoundingClientRect()
      const rect = content.getBoundingClientRect()
      const point = at ?? {
        x: view.left + view.width / 2,
        y: view.top + view.height / 2,
      }
      anchor.current = {
        ...point,
        across: rect.width ? (point.x - rect.left) / rect.width : 0,
        down: rect.height ? (point.y - rect.top) / rect.height : 0,
      }
    }
    setZoom(clamp(next))
  }, [])

  // A pinch on touch, and Ctrl with the wheel, which is also how a trackpad
  // pinch arrives; the page's own zoom and scroll keep every other gesture.
  // React listens to the wheel passively, so these listen themselves.
  useEffect(() => {
    const element = box.current!
    const touches = new Map<number, Point>()
    let pinch: { distance: number; zoom: number } | undefined
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const delta = Math.min(Math.max(event.deltaY, -WHEEL_DELTA), WHEEL_DELTA)
      zoomTo(current.current * Math.exp(-delta / 100), {
        x: event.clientX,
        y: event.clientY,
      })
    }
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const points = [...touches.values()]
      if (points.length === 2)
        pinch = { distance: distance(points), zoom: current.current }
    }
    const move = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const points = [...touches.values()]
      if (!pinch || points.length !== 2 || !pinch.distance) return
      zoomTo((pinch.zoom * distance(points)) / pinch.distance, middle(points))
    }
    const up = (event: PointerEvent) => {
      touches.delete(event.pointerId)
      if (touches.size < 2) pinch = undefined
    }
    element.addEventListener("wheel", wheel, { passive: false })
    element.addEventListener("pointerdown", down)
    element.addEventListener("pointermove", move)
    element.addEventListener("pointerup", up)
    element.addEventListener("pointercancel", up)
    return () => {
      element.removeEventListener("wheel", wheel)
      element.removeEventListener("pointerdown", down)
      element.removeEventListener("pointermove", move)
      element.removeEventListener("pointerup", up)
      element.removeEventListener("pointercancel", up)
    }
  }, [zoomTo])

  const turn = useRef(onTurn)
  useEffect(() => {
    turn.current = onTurn
  })
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return
      if (event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(OWN_KEYS)) return
      if (/^(?: |Enter)$/u.test(event.key) && target?.closest(PRESSABLE)) return
      const to = ZOOM_KEYS[event.key]
      if (to) {
        event.preventDefault()
        zoomTo(to(current.current))
        return
      }
      const element = box.current!
      const action = keyAction(event, element)
      if (!action) return
      if ("turn" in action) {
        fromBelow.current =
          action.turn === "previous" && SCROLL_KEYS[event.key]?.[0] === "y"
        if (turn.current?.(action.turn)) event.preventDefault()
        else fromBelow.current = false
        return
      }
      event.preventDefault()
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches
      element.scrollBy({
        ...action.scroll,
        behavior: still ? "auto" : "smooth",
      })
    }
    window.addEventListener("keydown", keyDown)
    return () => window.removeEventListener("keydown", keyDown)
  }, [zoomTo])

  return (
    <div
      ref={pane}
      className="flex flex-col gap-2"
      style={fill ? { height: room.height } : undefined}
    >
      <Toolbar>
        {controls}
        <IconButton
          label={labels.zoomOut}
          disabled={zoom === 1}
          onClick={() => zoomTo(zoom / STEP)}
        >
          <ZoomOut />
        </IconButton>
        <output className="min-w-12 text-center text-xs text-muted-foreground tabular-nums">
          {labels.zoomLevel(Math.round(zoom * 100))}
        </output>
        <IconButton
          label={labels.zoomIn}
          disabled={zoom === MAX_ZOOM}
          onClick={() => zoomTo(zoom * STEP)}
        >
          <ZoomIn />
        </IconButton>
        <IconButton
          label={labels.zoomFit}
          disabled={zoom === 1}
          onClick={() => zoomTo(1)}
        >
          <Shrink />
        </IconButton>
      </Toolbar>
      <div
        ref={body}
        className={cn("relative flex min-h-0", fill && "flex-1")}
        style={{ maxHeight: space.height }}
      >
        {aside}
        {/* The content is laid out left to right, so panning is too. */}
        <div
          ref={box}
          role="region"
          aria-label={label}
          tabIndex={0}
          dir="ltr"
          className="flex min-w-0 flex-1 touch-pan-x touch-pan-y overflow-auto rounded-md outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {children(space, zoom)}
        </div>
      </div>
    </div>
  )
}
