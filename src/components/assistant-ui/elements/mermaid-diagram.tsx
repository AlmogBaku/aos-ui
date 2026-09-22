"use client"

import { useAuiState } from "@assistant-ui/react"
import type {
  CodeHeaderProps,
  SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown"
import {
  ChevronDown,
  LoaderCircle,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { useTheme } from "next-themes"
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FC,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react"

import { CopyButton } from "@/components/tool-ui/common"
import { useToolUiLocale } from "@/components/tool-ui/locale"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

import { sanitizeMermaidSvg } from "./mermaid-sanitize"

export const MERMAID_MAX_SOURCE_CHARS = 20_000
export const MERMAID_MAX_SOURCE_LINES = 400
const MERMAID_MAX_EDGES = 300

// The compact card's viewport is about 612px wide, so a diagram past this is
// already being scaled down today and earns the wide frame instead.
const MERMAID_COMPACT_MAX_WIDTH = 576
// The same bound DESIGN.md already sets for inline video.
const MERMAID_COMPACT_MAX_HEIGHT = 384
// Mermaid's default label font is 16px, so this floor keeps diagram text near
// 11px rather than fitting a wide diagram at an unreadable size.
const MERMAID_MIN_READABLE_SCALE = 0.7
const MERMAID_MIN_ZOOM = 0.5
const MERMAID_MAX_ZOOM = 3
const MERMAID_ZOOM_STEP = 1.25

type DiagramSize = { width: number; height: number }

function countSourceLines(source: string) {
  if (source.length === 0) return 0

  const lineBreakCount = source.match(/\r\n|\r|\n/g)?.length ?? 0
  // A trailing line break terminates the last line without adding an empty one.
  const hasTrailingLineBreak = /(?:\r\n|\r|\n)$/.test(source)
  return lineBreakCount + (hasTrailingLineBreak ? 0 : 1)
}

// Mermaid reports a diagram's intrinsic size through the root viewBox. Nested
// markers carry their own viewBox, so the document has to be parsed rather than
// pattern matched.
function readDiagramSize(svg: string): DiagramSize | null {
  try {
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml")
    if (parsed.getElementsByTagName("parsererror").length > 0) return null

    const root = parsed.documentElement
    if (root.localName !== "svg") return null

    const viewBox = root.getAttribute("viewBox")
    if (viewBox) {
      const values = viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number)
      if (
        values.length === 4 &&
        values.every((value) => Number.isFinite(value))
      ) {
        const size = { width: values[2]!, height: values[3]! }
        if (size.width > 0 && size.height > 0) return size
      }
    }

    const declared = {
      width: Number.parseFloat(root.getAttribute("width") ?? ""),
      height: Number.parseFloat(root.getAttribute("height") ?? ""),
    }
    if (declared.width > 0 && declared.height > 0) return declared

    return null
  } catch {
    return null
  }
}

function isCompactDiagram(size: DiagramSize | null) {
  return (
    size === null ||
    (size.width <= MERMAID_COMPACT_MAX_WIDTH &&
      size.height <= MERMAID_COMPACT_MAX_HEIGHT)
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function stepZoom(zoom: number, direction: 1 | -1) {
  return clamp(
    direction === 1 ? zoom * MERMAID_ZOOM_STEP : zoom / MERMAID_ZOOM_STEP,
    MERMAID_MIN_ZOOM,
    MERMAID_MAX_ZOOM
  )
}

// Never upscale past the diagram's own size, never shrink below the readable
// floor, and otherwise fit the frame. One expression, so the diagram keeps
// following its container without measuring it.
function diagramHolderWidth(size: DiagramSize, zoom: number) {
  const natural = Math.round(size.width)
  const floor = Math.round(size.width * MERMAID_MIN_READABLE_SCALE)
  return `calc(min(${natural}px, max(100%, ${floor}px)) * ${zoom})`
}

type DiagramState =
  | {
      phase: "ready"
      source: string
      theme: "dark" | "default"
      svg: string
      size: DiagramSize | null
    }
  | { phase: "failed"; source: string; theme: "dark" | "default" }

const mermaidLabels = {
  en: {
    diagram: "Mermaid diagram",
    rendering: "Rendering diagram…",
    failed: "Diagram could not be rendered.",
    tooLarge: "Diagram source is too large to render safely.",
    viewSource: "View diagram source",
    hideSource: "Hide diagram source",
    source: "Diagram source",
    copySource: "Copy diagram source",
    zoomIn: "Zoom in on the diagram",
    zoomOut: "Zoom out of the diagram",
    zoomLabel: "Diagram zoom",
    expand: "Expand the diagram",
    expandedDiagram: "Mermaid diagram, expanded view",
    closeExpanded: "Close the expanded diagram",
  },
  he: {
    diagram: "תרשים Mermaid",
    rendering: "התרשים נטען…",
    failed: "לא ניתן להציג את התרשים.",
    tooLarge: "מקור התרשים גדול מדי להצגה בטוחה.",
    viewSource: "הצגת מקור התרשים",
    hideSource: "הסתרת מקור התרשים",
    source: "מקור התרשים",
    copySource: "העתקת מקור התרשים",
    zoomIn: "הגדלת התרשים",
    zoomOut: "הקטנת התרשים",
    zoomLabel: "תקריב התרשים",
    expand: "הרחבת התרשים",
    expandedDiagram: "תרשים Mermaid, תצוגה מורחבת",
    closeExpanded: "סגירת התרשים המורחב",
  },
} as const

type MermaidLabels = (typeof mermaidLabels)[keyof typeof mermaidLabels]

let mermaidRenderQueue = Promise.resolve()

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const pending = mermaidRenderQueue.then(task, task)
  mermaidRenderQueue = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}

function SourcePanel({ code }: { code: string }) {
  const { locale } = useToolUiLocale()
  const labels = mermaidLabels[locale]

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/30">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {labels.source}
        </span>
        <CopyButton value={code} label={labels.copySource} />
      </div>
      <pre
        className="max-h-72 overflow-auto p-3 text-start font-mono text-xs leading-relaxed text-foreground"
        dir="ltr"
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Drag-to-pan for wide diagram frames. Returns a ref to attach to the
// scrollable element and the three mouse handlers to spread onto it.
function useDragToPan(): {
  frameRef: RefObject<HTMLDivElement | null>
  isDragging: boolean
  onMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void
  onMouseMove: (e: ReactMouseEvent<HTMLDivElement>) => void
  onMouseUp: () => void
} {
  const frameRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    scrollLeft: number
    scrollTop: number
  } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const onMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    // Only primary button; skip clicks on interactive children.
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest("a, button, input, select, textarea")) return
    const el = frameRef.current
    if (!el) return
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    }
    setIsDragging(true)
    e.preventDefault()
  }, [])

  const onMouseMove = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragRef.current || !frameRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    frameRef.current.scrollLeft = dragRef.current.scrollLeft - dx
    frameRef.current.scrollTop = dragRef.current.scrollTop - dy
  }, [])

  const onMouseUp = useCallback(() => {
    dragRef.current = null
    setIsDragging(false)
  }, [])

  return { frameRef, isDragging, onMouseDown, onMouseMove, onMouseUp }
}

function DiagramFrame({
  svg,
  size,
  label,
  zoom,
  fill = false,
}: {
  svg: string
  size: DiagramSize | null
  label: string
  zoom: number
  fill?: boolean
}) {
  const { frameRef, isDragging, onMouseDown, onMouseMove, onMouseUp } =
    useDragToPan()

  if (size === null || isCompactDiagram(size)) {
    return (
      <div
        className="overflow-auto rounded-lg bg-background p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        role="img"
        aria-label={label}
        dir="ltr"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }

  return (
    <div
      ref={frameRef}
      className={cn(
        "[scrollbar-gutter:stable] overflow-auto rounded-lg bg-background p-4 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        // Mermaid writes an inline max-width on the SVG, so only an important
        // utility lets a zoom past the fitted width take effect.
        "[&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-none!",
        // The frame hugs its diagram and scrolls past this bound, so a tall
        // diagram cannot take over the conversation.
        fill ? "min-h-0" : "max-h-112",
        isDragging ? "cursor-grabbing select-none" : "cursor-grab"
      )}
      role="img"
      aria-label={label}
      dir="ltr"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <div
        className="mx-auto"
        style={{
          width: diagramHolderWidth(size, zoom),
          // While the expanded view holds the diagram this holder is empty, and
          // its own ratio is what keeps the frame from collapsing underneath.
          aspectRatio:
            svg === "" ? `${size.width} / ${size.height}` : undefined,
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

function DiagramZoomControls({
  zoom,
  onZoomChange,
  labels,
}: {
  zoom: number
  onZoomChange: (zoom: number) => void
  labels: MermaidLabels
}) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground"
        aria-label={labels.zoomOut}
        disabled={zoom <= MERMAID_MIN_ZOOM}
        onClick={() => onZoomChange(stepZoom(zoom, -1))}
      >
        <ZoomOut aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground"
        aria-label={labels.zoomIn}
        disabled={zoom >= MERMAID_MAX_ZOOM}
        onClick={() => onZoomChange(stepZoom(zoom, 1))}
      >
        <ZoomIn aria-hidden="true" />
      </Button>
      <span className="sr-only" aria-live="polite">
        {`${labels.zoomLabel} ${Math.round(zoom * 100)}%`}
      </span>
    </>
  )
}

function ExpandedDiagram({
  svg,
  size,
  labels,
  open,
  onOpenChange,
}: {
  svg: string
  size: DiagramSize | null
  labels: MermaidLabels
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [zoom, setZoom] = useState(1)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setZoom(1)
        onOpenChange(next)
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
          />
        }
        aria-label={labels.expand}
      >
        <Maximize2 aria-hidden="true" />
      </DialogTrigger>
      <DialogContent
        closeLabel={labels.closeExpanded}
        overlayClassName="bg-black/60 supports-backdrop-filter:backdrop-blur-sm"
        className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-none flex-col gap-2 bg-card p-3 text-card-foreground sm:w-[95vw] sm:max-w-none"
      >
        <DialogTitle className="sr-only">{labels.expandedDiagram}</DialogTitle>
        <DiagramFrame
          svg={svg}
          size={size}
          label={labels.expandedDiagram}
          zoom={zoom}
          fill
        />
        <div className="flex items-center gap-1 pe-8">
          <DiagramZoomControls
            zoom={zoom}
            onZoomChange={setZoom}
            labels={labels}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

export const MermaidCodeHeader: FC<CodeHeaderProps> = () => null

export function MermaidDiagram({ code }: SyntaxHighlighterProps) {
  const partStatus = useAuiState((state) => state.part.status.type)
  const { locale, direction } = useToolUiLocale()
  const labels = mermaidLabels[locale]
  const { forcedTheme, resolvedTheme } = useTheme()
  const renderTheme =
    forcedTheme === "dark" ||
    (forcedTheme !== "light" && resolvedTheme === "dark")
      ? "dark"
      : "default"
  const renderId = `mermaid-${useId().replace(/:/g, "")}`
  const revisionRef = useRef(0)
  const [openSourceKey, setOpenSourceKey] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [zoomState, setZoomState] = useState<{
    key: string
    zoom: number
  } | null>(null)
  const [diagram, setDiagram] = useState<DiagramState | null>(null)
  const tooLarge =
    code.length > MERMAID_MAX_SOURCE_CHARS ||
    countSourceLines(code) > MERMAID_MAX_SOURCE_LINES

  useEffect(() => {
    const revision = ++revisionRef.current
    let active = true

    if (partStatus !== "complete" || tooLarge) {
      return () => {
        active = false
      }
    }

    void enqueueMermaidRender(async () => {
      const { default: mermaid } = await import("mermaid")

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        htmlLabels: false,
        maxTextSize: MERMAID_MAX_SOURCE_CHARS,
        maxEdges: MERMAID_MAX_EDGES,
        secure: [
          "secure",
          "securityLevel",
          "startOnLoad",
          "suppressErrorRendering",
          "htmlLabels",
          "maxTextSize",
          "maxEdges",
          "theme",
        ],
        theme: renderTheme,
      })

      const result = await mermaid.render(renderId, code)
      const svg = sanitizeMermaidSvg(result.svg)
      return { svg, size: readDiagramSize(svg) }
    }).then(
      ({ svg, size }) => {
        if (active && revisionRef.current === revision) {
          setDiagram({
            phase: "ready",
            source: code,
            theme: renderTheme,
            svg,
            size,
          })
        }
      },
      () => {
        if (active && revisionRef.current === revision) {
          setDiagram({ phase: "failed", source: code, theme: renderTheme })
        }
      }
    )

    return () => {
      active = false
    }
  }, [code, partStatus, renderId, renderTheme, tooLarge])

  const sourceKey = `${renderTheme}\0${code}`
  const isCurrentDiagram =
    diagram?.source === code && diagram.theme === renderTheme
  const phase =
    partStatus === "running"
      ? "waiting"
      : partStatus === "incomplete"
        ? "failed"
        : tooLarge
          ? "too-large"
          : isCurrentDiagram
            ? diagram.phase
            : "loading"
  const sourceOpen = openSourceKey === sourceKey
  const sourceIsForced = phase !== "ready"
  const showSource = sourceIsForced || sourceOpen
  const ready = phase === "ready" && diagram?.phase === "ready" ? diagram : null
  // Every zoom and expand state is keyed by the rendered source and theme, so a
  // streamed edit or a theme flip resets it during render.
  const compact = ready === null || isCompactDiagram(ready.size)
  const zoom = zoomState?.key === sourceKey ? zoomState.zoom : 1
  const expanded = expandedKey === sourceKey

  return (
    <section
      className={cn(
        "my-3 flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-3.5 text-card-foreground",
        compact ? "max-w-2xl" : "w-full"
      )}
      dir={direction}
      lang={locale}
      aria-busy={phase === "loading" || phase === "waiting"}
    >
      {phase === "loading" || phase === "waiting" ? (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <LoaderCircle
            className="size-4 motion-safe:animate-spin"
            aria-hidden="true"
          />
          {labels.rendering}
        </div>
      ) : null}

      {phase === "failed" || phase === "too-large" ? (
        <p className="text-sm text-destructive" role="alert">
          {phase === "too-large" ? labels.tooLarge : labels.failed}
        </p>
      ) : null}

      {ready ? (
        <DiagramFrame
          // The expanded view holds the one copy of the diagram while it is
          // open; the frame keeps its height so nothing shifts underneath it.
          svg={expanded ? "" : ready.svg}
          size={ready.size}
          label={labels.diagram}
          zoom={zoom}
        />
      ) : null}

      {ready ? (
        <div className="flex flex-wrap items-center gap-1">
          {compact ? null : (
            <>
              <DiagramZoomControls
                zoom={zoom}
                onZoomChange={(next) =>
                  setZoomState({ key: sourceKey, zoom: next })
                }
                labels={labels}
              />
              <ExpandedDiagram
                svg={ready.svg}
                size={ready.size}
                labels={labels}
                open={expanded}
                onOpenChange={(next) => setExpandedKey(next ? sourceKey : null)}
              />
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn(
              "w-fit text-muted-foreground",
              compact ? null : "ms-auto"
            )}
            aria-expanded={sourceOpen}
            onClick={() => setOpenSourceKey(sourceOpen ? null : sourceKey)}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "transition-transform motion-reduce:transition-none",
                sourceOpen && "rotate-180"
              )}
            />
            {sourceOpen ? labels.hideSource : labels.viewSource}
          </Button>
        </div>
      ) : null}

      {showSource ? <SourcePanel code={code} /> : null}
    </section>
  )
}
