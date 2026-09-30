import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import { ChevronLeft, ChevronRight } from "lucide-react"
import {
  PDFWorker,
  TextLayer,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import {
  PDFJS_RESOURCE_URI,
  PDFJS_WORKER_FILE,
} from "../../../../shared/presentation/views"
import type { ViewLabels } from "../locale"
import { IconButton } from "../ui/icon-button"
import { Status } from "../ui/status"
import type { ViewApp } from "../view"
import styles from "./pdf-preview.module.css"

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

/**
 * One page at a time, drawn to fit the view's width, with its text laid over
 * it for selection and screen readers. The page keys turn it.
 */
function PdfPages({ pdf, labels }: { pdf: PDFDocumentProxy; labels: Labels }) {
  const pages = pdf.numPages
  const [page, setPage] = useState(1)
  const [width, setWidth] = useState(0)
  const region = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(region.current!)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (width === 0) return
    let cancelled = false
    let drawing: RenderTask | undefined
    let layer: TextLayer | undefined
    void pdf
      .getPage(page)
      .then((pdfPage) => {
        if (cancelled) return
        const viewport = pdfPage.getViewport({
          scale: width / pdfPage.getViewport({ scale: 1 }).width,
        })
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
        )
        const target = canvas.current!
        target.width = Math.floor(viewport.width * ratio)
        target.height = Math.floor(viewport.height * ratio)
        // pdf.js sizes the text layer and each run of text by this factor.
        sheet.current!.style.setProperty(
          "--total-scale-factor",
          String(viewport.scale * viewport.userUnit)
        )
        drawing = pdfPage.render({
          canvas: target,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        })
        text.current!.replaceChildren()
        layer = new TextLayer({
          textContentSource: pdfPage.streamTextContent(),
          container: text.current!,
          viewport,
        })
        return Promise.all([drawing.promise, layer.render()])
      })
      // A page turned or resized mid-draw cancels the draw, which rejects.
      .catch(() => undefined)
    return () => {
      cancelled = true
      drawing?.cancel()
      layer?.cancel()
    }
  }, [pdf, page, width])

  const turn = (event: KeyboardEvent) => {
    const to = PAGE_KEYS[event.key]
    if (!to) return
    event.preventDefault()
    setPage(Math.min(Math.max(to(page, pages), 1), pages))
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={region}
        role="region"
        aria-label={labels.pdfTitle}
        tabIndex={0}
        onKeyDown={turn}
        className="overflow-hidden rounded-md border outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {/* pdf.js places text by physical offsets, in either direction. */}
        <div ref={sheet} dir="ltr" className={styles.page}>
          <canvas ref={canvas} aria-hidden="true" />
          <div ref={text} className={styles.textLayer} />
        </div>
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-center gap-2">
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
        </div>
      ) : null}
    </div>
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
}: {
  blob: Blob
  read: Read
  labels: Labels
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
  return <PdfPages pdf={pdf} labels={labels} />
}
