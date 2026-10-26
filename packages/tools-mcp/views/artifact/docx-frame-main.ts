import { renderAsync } from "docx-preview"

import { DOCX_CONTAINER_ID, DOCX_FAILED } from "./docx-frame"

/**
 * The Word renderer, built as one classic script the artifact view inlines
 * into a Word frame. It draws the one document its parent posts with
 * docx-preview, never an embedded HTML part, with pictures and fonts as
 * `data:` addresses, and keeps the pages fitted to the frame's width; a
 * document it cannot draw it reports to the view.
 */
const root = document.documentElement
/** The width of the widest page with the margin around it, unzoomed. */
let pageWidth = 0
let fit = 1

/**
 * Fits the pages to the frame's width, keeping a reader's own zoom as the
 * same share of the fit; `ZOOM_SCRIPT` zooms from the fit it reads here.
 */
function refit() {
  if (pageWidth === 0) return
  const next = innerWidth / pageWidth
  const zoom = Number(root.style.zoom || fit)
  root.dataset.fit = String(next)
  root.style.zoom = String(next * (zoom / fit))
  fit = next
}

/**
 * The widest page in `container` and its wrapper's margins, at zoom 1. The
 * container holds docx-preview's styles before its wrapper.
 */
function measure(container: HTMLElement) {
  const wrapper = container.querySelector(":scope > .docx-wrapper")
  const pages = [...container.querySelectorAll("section")]
  const widest = Math.max(0, ...pages.map((page) => page.offsetWidth))
  const margin =
    wrapper instanceof HTMLElement
      ? Number.parseFloat(getComputedStyle(wrapper).paddingLeft) * 2
      : 0
  return widest + (margin || 0)
}

let taken = false
// The script runs in the frame's head, before its body is there: the page's
// container is found once the document comes.
addEventListener("message", ({ source, data }: MessageEvent<unknown>) => {
  const bytes = (data as { bytes?: unknown } | null)?.bytes
  const container = document.getElementById(DOCX_CONTAINER_ID)
  if (taken || source !== parent || !(bytes instanceof ArrayBuffer)) return
  if (container === null) return
  taken = true
  renderAsync(bytes, container, undefined, {
    ignoreLastRenderedPageBreak: false,
    renderAltChunks: false,
    useBase64URL: true,
  }).then(
    () => {
      pageWidth = measure(container)
      refit()
      addEventListener("resize", refit)
    },
    () => parent.postMessage({ type: DOCX_FAILED }, "*")
  )
})
