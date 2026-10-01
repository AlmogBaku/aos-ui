import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist"
import { useEffect, useRef, useState } from "react"

import type { ViewLabels } from "../locale"
import { cn } from "../ui/cn"
import { Tabs } from "../ui/tabs"

type Labels = ViewLabels["artifact"]

type Outline = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>

type OutlineItem = NonNullable<Outline>[number]

type PageReference = Parameters<PDFDocumentProxy["getPageIndex"]>[0]

/** How wide a page's thumbnail is drawn, in CSS pixels. */
const THUMBNAIL_WIDTH = 96

/** The sharpest a thumbnail is drawn, however dense the screen. */
const THUMBNAIL_RATIO = 2

/** The page an outline entry leads to, or none when it leads off the file. */
async function pageOf(pdf: PDFDocumentProxy, item: OutlineItem) {
  const destination =
    typeof item.dest === "string"
      ? await pdf.getDestination(item.dest)
      : item.dest
  const target: unknown = destination?.[0]
  if (typeof target === "number") return target + 1
  if (target && typeof target === "object")
    return (await pdf.getPageIndex(target as PageReference)) + 1
  return undefined
}

/** The file's outline, or none when it has no entries. */
function useOutline(pdf: PDFDocumentProxy) {
  const [outline, setOutline] = useState<NonNullable<Outline>>([])
  useEffect(() => {
    let cancelled = false
    void pdf.getOutline().then(
      (items) => {
        if (!cancelled) setOutline(items ?? [])
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [pdf])
  return outline
}

function OutlineList({
  items,
  pdf,
  onPage,
}: {
  items: OutlineItem[]
  pdf: PDFDocumentProxy
  onPage: (page: number) => void
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {items.map((item, index) => (
        <li key={index}>
          {item.dest ? (
            <button
              type="button"
              className="w-full cursor-pointer rounded-sm px-2 py-1 text-start text-xs wrap-anywhere outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-11"
              onClick={() =>
                void pageOf(pdf, item).then(
                  (page) => page && onPage(page),
                  () => undefined
                )
              }
            >
              {item.title}
            </button>
          ) : (
            <span className="block px-2 py-1 text-xs wrap-anywhere text-muted-foreground">
              {item.title}
            </span>
          )}
          {item.items.length > 0 ? (
            <div className="ps-3">
              <OutlineList items={item.items} pdf={pdf} onPage={onPage} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * One page drawn small while it is in sight; out of sight its canvas lets go
 * of its pixels, so a long file holds only the thumbnails on screen.
 */
function Thumbnail({ pdf, page }: { pdf: PDFDocumentProxy; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [aspect, setAspect] = useState<number>()

  useEffect(() => {
    if (typeof IntersectionObserver !== "function") return
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting === true)
    )
    observer.observe(canvas.current!)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    const target = canvas.current!
    let cancelled = false
    let drawing: RenderTask | undefined
    void pdf
      .getPage(page)
      .then((pdfPage) => {
        if (cancelled) return
        const unscaled = pdfPage.getViewport({ scale: 1 })
        const ratio = Math.min(window.devicePixelRatio || 1, THUMBNAIL_RATIO)
        const viewport = pdfPage.getViewport({
          scale: (THUMBNAIL_WIDTH * ratio) / unscaled.width,
        })
        target.width = Math.floor(viewport.width)
        target.height = Math.floor(viewport.height)
        setAspect(unscaled.width / unscaled.height)
        drawing = pdfPage.render({ canvas: target, viewport })
        return drawing.promise
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      drawing?.cancel()
      target.width = 0
      target.height = 0
    }
  }, [pdf, page, visible])

  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      className="block w-full bg-white ring-1 ring-border"
      style={{ aspectRatio: aspect ?? 3 / 4 }}
    />
  )
}

/**
 * The file's outline, when it has one, and its pages as thumbnails; either
 * turns the page. Beside the page it takes its own column; `overlay` lays it
 * over the page instead, at the inline start.
 */
export function PdfSidebar({
  pdf,
  page,
  overlay,
  labels,
  onPage,
}: {
  pdf: PDFDocumentProxy
  page: number
  overlay: boolean
  labels: Labels
  onPage: (page: number) => void
}) {
  const outline = useOutline(pdf)
  const [chosen, setChosen] = useState<"outline" | "pages">()
  const tabs = [
    ...(outline.length > 0
      ? [{ name: "outline" as const, label: labels.outline }]
      : []),
    { name: "pages" as const, label: labels.pages },
  ]
  const tab = chosen ?? tabs[0]!.name
  return (
    <nav
      aria-label={labels.sidebar}
      className={cn(
        "flex w-44 shrink-0 flex-col gap-2 rounded-md border bg-background p-2",
        overlay && "absolute inset-y-0 start-0 z-10 shadow-lg"
      )}
    >
      <Tabs
        label={labels.sidebar}
        tabs={tabs}
        selected={tab}
        onSelect={setChosen}
        className="min-h-0 flex-1 overflow-auto"
      >
        {tab === "outline" ? (
          <OutlineList items={outline} pdf={pdf} onPage={onPage} />
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {Array.from({ length: pdf.numPages }, (_, index) => index + 1).map(
              (number) => (
                <li key={number}>
                  <button
                    type="button"
                    aria-current={number === page ? "page" : undefined}
                    className="flex w-full cursor-pointer flex-col items-center gap-1 rounded-sm p-1 text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
                    onClick={() => onPage(number)}
                  >
                    <Thumbnail pdf={pdf} page={number} />
                    {labels.goToPage(number)}
                  </button>
                </li>
              )
            )}
          </ol>
        )}
      </Tabs>
    </nav>
  )
}
