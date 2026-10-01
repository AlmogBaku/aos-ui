import { useMemo, useState } from "react"

import type { ViewLabels } from "../locale"
import { Tabs } from "../ui/tabs"
import type { ViewApp } from "../view"
import { Code } from "./code"
import { CopyButton } from "./copy-button"
import { MAX_ZOOM } from "./zoom"

const TABS = ["preview", "source"] as const

/**
 * What Agent HTML may do: run its own inline scripts and styles, and show
 * images and media from `data:` and `blob:` addresses. It reaches no network,
 * frame, form, or plugin. Its frame also inherits the view's own policy, which
 * only narrows this one.
 */
export const AGENT_HTML_CSP = [
  "default-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
].join("; ")

/**
 * Zooms the file's own page with Ctrl and the wheel, which is also how a
 * trackpad pinch arrives, from fitted up to the view's `MAX_ZOOM`. A wheel
 * over the frame never reaches the view, and unhandled it would zoom the
 * whole page instead.
 */
const ZOOM_SCRIPT = `addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return
  event.preventDefault()
  const root = document.documentElement
  const delta = Math.min(Math.max(event.deltaY, -25), 25)
  const zoom = Number(root.style.zoom || 1) * Math.exp(-delta / 100)
  root.style.zoom = String(Math.min(Math.max(zoom, 1), ${MAX_ZOOM}))
}, { passive: false })`

/**
 * The file's HTML with the policy as the first child of its head, so it
 * governs every script the file holds, and the zoom script after it. The
 * page's `injectHtmlCsp` does the same for a view; the view cannot import
 * the page's code.
 */
function withPolicy(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html")
  const meta = document.createElement("meta")
  meta.httpEquiv = "Content-Security-Policy"
  meta.content = AGENT_HTML_CSP
  const script = document.createElement("script")
  script.textContent = ZOOM_SCRIPT
  document.head.prepend(meta, script)
  return `<!doctype html>${document.documentElement.outerHTML}`
}

/**
 * An HTML file, run with its scripts in a frame of its own, beside its source
 * highlighted as HTML with a Copy of its own, either `height` pixels tall. The tabs between them sit
 * among the view's controls; the arrow keys, Home, and End move between them.
 */
export function HtmlPreview({
  text,
  height,
  labels,
  read,
}: {
  text: string
  height: number
  labels: ViewLabels["artifact"]
  read: ViewApp["readServerResource"]
}) {
  const html = useMemo(() => withPolicy(text), [text])
  const [tab, setTab] = useState<(typeof TABS)[number]>("preview")
  return (
    <div className="flex flex-col" style={{ height }}>
      <Tabs
        toolbar
        label={labels.htmlView}
        tabs={TABS.map((name) => ({ name, label: labels[name] }))}
        selected={tab}
        onSelect={setTab}
        className="min-h-0 flex-1"
      >
        {tab === "preview" ? (
          // Scripts without the same origin: the file runs in an opaque
          // origin of its own, so it reaches neither this view nor the page.
          <iframe
            sandbox="allow-scripts"
            srcDoc={html}
            title={labels.htmlTitle}
            referrerPolicy="no-referrer"
            className="block h-full w-full rounded-md border bg-white"
          />
        ) : (
          // Copy shows over the source on hover or focus, and always on a
          // screen without hover.
          <div className="group relative h-full">
            <Code
              code={text}
              language="html"
              label={labels.source}
              read={read}
              className="h-full"
            />
            <div className="absolute end-2 top-2 rounded-md bg-muted opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
              <CopyButton text={text} labels={labels} />
            </div>
          </div>
        )}
      </Tabs>
    </div>
  )
}
