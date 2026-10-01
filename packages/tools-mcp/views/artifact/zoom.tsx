import { Shrink, ZoomIn, ZoomOut } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"

import type { ViewLabels } from "../locale"
import { cn } from "../ui/cn"
import { IconButton } from "../ui/icon-button"
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
 * Content fitted to the room, with zoom controls above it. A pinch, a
 * trackpad pinch or Ctrl with the wheel, the zoom keys (+, -, and 0 to fit),
 * or the controls zoom it about the point they act at; zoomed in, it scrolls
 * to pan. `children` lays the content out at a zoom in the space it fits.
 * Unless `fill` holds, the pane is only as tall as its fitted content.
 */
export function ZoomPane({
  room,
  label,
  labels,
  controls,
  aside,
  fill = false,
  onKeyDown,
  children,
}: {
  room: Room
  label: string
  labels: Labels
  controls?: ReactNode
  aside?: ReactNode
  fill?: boolean
  onKeyDown?: (event: KeyboardEvent) => void
  children: (space: Space, zoom: number) => ReactNode
}) {
  const pane = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [space, setSpace] = useState<Space>({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const current = useRef(zoom)
  const anchor = useRef<Anchor | undefined>(undefined)

  // The space below the controls and beside any aside, neither of which
  // moves as the content grows.
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
      zoomTo(
        (pinch.zoom * distance(points)) / pinch.distance,
        middle(points)
      )
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

  const keyDown = (event: KeyboardEvent) => {
    const to = ZOOM_KEYS[event.key]
    if (to && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      zoomTo(to(zoom))
      return
    }
    onKeyDown?.(event)
  }

  return (
    <div
      ref={pane}
      className="flex flex-col gap-2"
      style={fill ? { height: room.height } : undefined}
    >
      <div className="flex flex-wrap items-center justify-center gap-1">
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
      </div>
      <div
        ref={body}
        className={cn("relative flex min-h-0 gap-2", fill && "flex-1")}
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
          onKeyDown={keyDown}
          className="flex min-w-0 flex-1 touch-pan-x touch-pan-y overflow-auto rounded-md outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {children(space, zoom)}
        </div>
      </div>
    </div>
  )
}
