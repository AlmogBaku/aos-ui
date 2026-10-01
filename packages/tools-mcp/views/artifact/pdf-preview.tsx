import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import { ChevronLeft, ChevronRight, PanelLeft } from "lucide-react"
import {
  PDFWorker,
  TextLayer,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist"
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react"

import {
  PDFJS_RESOURCE_URI,
  PDFJS_WORKER_FILE,
} from "../../../../shared/presentation/views"
import type { ViewLabels } from "../locale"
import { cn } from "../ui/cn"
import { IconButton } from "../ui/icon-button"
import { Status } from "../ui/status"
import type { ViewApp } from "../view"
import { PdfSidebar } from "./pdf-sidebar"
import styles from "./pdf-preview.module.css"
import type { Room } from "./room"
import { ZoomPane, type Space } from "./zoom"

type Read = ViewApp["readServerResource"]
type Labels = ViewLabels["artifact"]

/** Where pdf.js's character maps, fonts, and decoders live on the server. */
const DATA_URLS = {
  cMapUrl: `${PDFJS_RESOURCE_URI}cmaps/`,
  standardFontDataUrl: `${PDFJS_RESOURCE_URI}standard_fonts/`,
  wasmUrl: `${PDFJS_RESOURCE_URI}wasm/`,
}

type DataKind = keyof typeof DATA_URLS

/** The largest canvas iOS Safari draws, which pdf.js's own viewer keeps to. */
const MAX_CANVAS_PIXELS = 2 ** 24

/** The page each paging key turns to. */
const PAGE_KEYS: Partial<
  Record<string, (page: number, pages: number) => number>
> = {
  PageUp: (page) => page - 1,
  PageDown: (page) => page + 1,
  Home: () => 1,
  End: (_page, pages) => pages,
}

function bytesOf({ contents: [content] }: ReadResourceResult) {
  if (content && "blob" in content && typeof content.blob === "string")
    return Uint8Array.from(atob(content.blob), (character) =>
      character.charCodeAt(0)
    )
  if (content && "text" in content && typeof content.text === "string")
    return new TextEncoder().encode(content.text)
  throw new Error(`No pdf.js file came back for ${content?.uri}`)
}

/**
 * The factory pdf.js asks for its data by name. The sandbox fetches nothing,
 * so each request becomes a `resources/read` to the server.
 */
function resourceDataFactory(read: Read) {
  return class ResourceDataFactory {
    readonly #urls: Record<DataKind, string>

    constructor(urls: Record<DataKind, string>) {
      this.#urls = urls
    }

    async fetch({ kind, filename }: { kind: DataKind; filename: string }) {
      return bytesOf(await read({ uri: `${this.#urls[kind]}${filename}` }))
    }
  }
}

let worker: Promise<PDFWorker> | undefined

/**
 * pdf.js's worker, started once and shared by every document. The sandbox
 * loads no script by address, so the view reads the worker's text from the
 * server and starts it from a blob URL; it counts as started once it says
 * it is ready.
 */
function pdfWorker(read: Read) {
  worker ??= read({ uri: `${PDFJS_RESOURCE_URI}${PDFJS_WORKER_FILE}` })
    .then(
      (script) =>
        new Promise<PDFWorker>((resolve, reject) => {
          const port = new Worker(
            URL.createObjectURL(
              new Blob([bytesOf(script)], { type: "text/javascript" })
            )
          )
          port.addEventListener(
            "message",
            () => resolve(PDFWorker.create({ port })),
            { once: true }
          )
          port.addEventListener(
            "error",
            () => reject(new Error("pdf.js's worker did not start")),
            { once: true }
          )
        })
    )
    .catch((error: unknown) => {
      worker = undefined
      throw error
    })
  return worker
}

/** How long a zoom rests before the page is drawn again at its new scale. */
const SETTLE_MS = 150

/** A narrower room lays the sidebar over the page instead of beside it. */
const SIDEBAR_BESIDE_WIDTH = 480

/** How far a turned page slides in, in CSS pixels, and for how long. */
const TURN = { distance: 24, duration: 200 }

/**
 * Slides a page just turned in from the side its turn came from, unless the
 * reader asks for less motion.
 */
function slideIn(sheet: HTMLElement, forward: boolean) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
  const rtl = document.documentElement.dir === "rtl"
  const from = (forward !== rtl ? 1 : -1) * TURN.distance
  sheet.animate(
    [
      { opacity: 0, transform: `translateX(${from}px)` },
      { opacity: 1, transform: "none" },
    ],
    { duration: TURN.duration, easing: "ease-out" }
  )
}

/**
 * One page fitted to the width of the space and zoomed, with its text laid
 * over it for selection and screen readers. A page is drawn off screen and
 * shown once whole, so the one before stays until it is; while a zoom
 * settles, the drawn page and its text scale together.
 */
function PdfSheet({
  pdf,
  page,
  space,
  zoom,
}: {
  pdf: PDFDocumentProxy
  page: number
  space: Space
  zoom: number
}) {
  const [loaded, setLoaded] = useState<{
    pdf: PDFDocumentProxy
    page: PDFPageProxy
  }>()
  const sheet = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const shown = useRef<number | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void pdf.getPage(page).then(
      (pdfPage) => {
        if (!cancelled) setLoaded({ pdf, page: pdfPage })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [pdf, page])

  const pdfPage = loaded?.pdf === pdf ? loaded.page : undefined
  const unscaled = pdfPage?.getViewport({ scale: 1 })
  const scale = unscaled ? (space.width / unscaled.width) * zoom : 0
  const [drawn, setDrawn] = useState(scale)
  useEffect(() => {
    const settle = setTimeout(() => setDrawn(scale), SETTLE_MS)
    return () => clearTimeout(settle)
  }, [scale])

  useEffect(() => {
    if (!pdfPage || drawn <= 0) return
    const viewport = pdfPage.getViewport({ scale: drawn })
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
    )
    const offscreen = document.createElement("canvas")
    offscreen.width = Math.floor(viewport.width * ratio)
    offscreen.height = Math.floor(viewport.height * ratio)
    const drawing = pdfPage.render({
      canvas: offscreen,
      viewport,
      transform: [ratio, 0, 0, ratio, 0, 0],
    })
    const layer = document.createElement("div")
    layer.className = styles.textLayer!
    const textLayer = new TextLayer({
      textContentSource: pdfPage.streamTextContent(),
      container: layer,
      viewport,
    })
    // A page turned or zoomed mid-draw cancels the draw, which rejects.
    Promise.all([drawing.promise, textLayer.render()]).then(
      () => {
        const target = canvas.current!
        target.width = offscreen.width
        target.height = offscreen.height
        target.getContext("2d")!.drawImage(offscreen, 0, 0)
        text.current!.replaceChildren(layer)
        const number = pdfPage.pageNumber
        if (shown.current !== undefined && shown.current !== number)
          slideIn(sheet.current!, number > shown.current)
        shown.current = number
      },
      () => undefined
    )
    return () => {
      drawing.cancel()
      textLayer.cancel()
    }
  }, [pdfPage, drawn])

  return (
    // pdf.js places text by physical offsets, in either direction.
    <div
      ref={sheet}
      dir="ltr"
      className={`${styles.page} mx-auto shrink-0 bg-white ring-1 ring-border`}
      style={
        unscaled
          ? ({
              width: Math.floor(unscaled.width * scale),
              height: Math.floor(unscaled.height * scale),
              // pdf.js sizes the text layer and each run of text by this
              // factor, so the text keeps to the page as it scales.
              "--total-scale-factor": scale * unscaled.userUnit,
            } as CSSProperties)
          : undefined
      }
    >
      <canvas ref={canvas} aria-hidden="true" />
      <div ref={text} />
    </div>
  )
}

/**
 * One page at a time, as wide as the room and zoomable, with paging and zoom
 * controls among the view's and a sidebar of the file's outline and pages
 * that the reader opens, which slides open beside the page or over it. The
 * page keys turn it.
 */
export function PdfPages({
  pdf,
  labels,
  room,
}: {
  pdf: PDFDocumentProxy
  labels: Labels
  room: Room
}) {
  const pages = pdf.numPages
  const [page, setPage] = useState(1)
  const [sidebar, setSidebar] = useState(false)
  const overlay = room.width < SIDEBAR_BESIDE_WIDTH

  const turn = (event: KeyboardEvent) => {
    const to = PAGE_KEYS[event.key]
    if (!to) return
    event.preventDefault()
    setPage(Math.min(Math.max(to(page, pages), 1), pages))
  }

  return (
    <ZoomPane
      room={room}
      label={labels.pdfTitle}
      labels={labels}
      fill
      start={page}
      onKeyDown={turn}
      controls={
        <>
          <IconButton
            label={labels.sidebar}
            expanded={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            <PanelLeft className="rtl:-scale-x-100" />
          </IconButton>
          {pages > 1 ? (
            <>
              <IconButton
                label={labels.previousPage}
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="rtl:-scale-x-100" />
              </IconButton>
              <p
                className="m-0 text-xs text-muted-foreground tabular-nums"
                aria-live="polite"
              >
                {labels.page(page, pages)}
              </p>
              <IconButton
                label={labels.nextPage}
                disabled={page === pages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="rtl:-scale-x-100" />
              </IconButton>
            </>
          ) : null}
        </>
      }
      aside={
        // The sidebar's column opens and closes by its width, so the page
        // beside it narrows and widens in step.
        <div
          className={cn(
            "flex shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none",
            sidebar ? "w-46" : "w-0",
            overlay && "absolute inset-y-0 start-0 z-10"
          )}
        >
          {sidebar ? (
            <PdfSidebar
              pdf={pdf}
              page={page}
              labels={labels}
              onPage={(next) => {
                setPage(next)
                // Over the page, the sidebar steps aside once it has turned it.
                if (overlay) setSidebar(false)
              }}
            />
          ) : null}
        </div>
      }
    >
      {(space, zoom) => (
        <PdfSheet pdf={pdf} page={page} space={space} zoom={zoom} />
      )}
    </ZoomPane>
  )
}

/**
 * A PDF read with pdf.js. A file pdf.js cannot open, such as one with a
 * password, has no preview.
 */
export function PdfPreview({
  blob,
  read,
  labels,
  room,
}: {
  blob: Blob
  read: Read
  labels: Labels
  room: Room
}) {
  const [loaded, setLoaded] = useState<{
    blob: Blob
    pdf: PDFDocumentProxy | null
  }>()

  useEffect(() => {
    let cancelled = false
    let loading: PDFDocumentLoadingTask | undefined
    void Promise.all([pdfWorker(read), blob.arrayBuffer()])
      .then(([shared, data]) => {
        if (cancelled) return
        loading = getDocument({
          data: new Uint8Array(data),
          worker: shared,
          BinaryDataFactory: resourceDataFactory(read),
          ...DATA_URLS,
          useSystemFonts: false,
          useWorkerFetch: false,
        })
        return loading.promise
      })
      .then(
        (pdf) => {
          if (!cancelled && pdf) setLoaded({ blob, pdf })
        },
        () => {
          if (!cancelled) setLoaded({ blob, pdf: null })
        }
      )
    return () => {
      cancelled = true
      void loading?.destroy()
    }
  }, [blob, read])

  const pdf = loaded?.blob === blob ? loaded.pdf : undefined
  if (pdf === undefined) return <Status>{labels.loading}</Status>
  if (pdf === null) return <Status>{labels.noPreview}</Status>
  return <PdfPages pdf={pdf} labels={labels} room={room} />
}
