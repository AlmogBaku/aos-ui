import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"

import { AGENT_HTML_DOMAINS } from "../../../../shared/presentation/views"
import type { ViewLabels } from "../locale"
import { Tabs } from "../ui/tabs"
import type { ViewApp } from "../view"
import { Code } from "./code"
import { CopyButton } from "./copy-button"
import { MAX_ZOOM } from "./zoom"

const TABS = ["preview", "source"] as const

const CDNS = AGENT_HTML_DOMAINS.join(" ")

/**
 * What Agent HTML may do: run its own inline scripts and styles, load scripts,
 * styles, and fonts from the public CDNs `AGENT_HTML_DOMAINS` names, and show
 * images and media from `data:` and `blob:` addresses. It connects to nothing
 * and reaches no other host, frame, form, or plugin. Its frame also inherits
 * the view's own policy, which only narrows this one.
 *
 * In addition to this CSP, `installStandIns` is injected before the page's
 * own scripts and gives it in-memory `localStorage` and `sessionStorage` for
 * the life of the preview. `https:` link clicks and `window.open` calls post
 * an `aos/openLink` message to the view (via `parent.postMessage`); the view
 * calls `ui/open-link` to open the URL in the workspace.
 */
export const AGENT_HTML_CSP = [
  "default-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  `script-src 'unsafe-inline' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS}`,
  "img-src data: blob:",
  "media-src data: blob:",
  `font-src data: ${CDNS}`,
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

/** The message the file's frame sends the view for a link the file opens. */
export const AGENT_LINK = "aos/openLink"

/** What the stand-ins replace and reach in the file's window. */
export type AgentWindow = Pick<
  Window,
  "localStorage" | "sessionStorage" | "addEventListener" | "open"
> & { parent: Pick<Window, "postMessage"> }

/**
 * Stands in for what the file's opaque origin takes from it. Web storage
 * lives in memory for the life of the preview. A click on an https link the
 * page left to the browser, and `window.open` with an https address, go up to
 * the view as a `linkType` message; any other address stays the page's own.
 * The file's frame runs it from its source, so it reaches nothing outside
 * itself.
 */
export function installStandIns(page: AgentWindow, linkType: string) {
  // As the standard does, it keeps every key and value as a string.
  const memory = () => {
    const items = new Map<string, string>()
    return {
      get length() {
        return items.size
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(String(key)) ?? null,
      setItem: (key: string, value: string) => {
        items.set(String(key), String(value))
      },
      removeItem: (key: string) => {
        items.delete(String(key))
      },
      clear: () => {
        items.clear()
      },
    }
  }
  Object.defineProperties(page, {
    localStorage: { value: memory() },
    sessionStorage: { value: memory() },
  })
  const relay = (address: unknown) => {
    let url: URL
    try {
      url = new URL(String(address))
    } catch {
      return false
    }
    if (url.protocol !== "https:") return false
    page.parent.postMessage({ type: linkType, url: url.href }, "*")
    return true
  }
  page.addEventListener("click", (event) => {
    const link =
      event.target instanceof Element ? event.target.closest("a[href]") : null
    if (link && !event.defaultPrevented && relay(link.getAttribute("href")))
      event.preventDefault()
  })
  page.open = (address) => {
    relay(address)
    return null
  }
}

/** The stand-ins as the file's frame runs them, on its own window. */
const STAND_INS_SCRIPT = `(${installStandIns.toString()})(window, ${JSON.stringify(AGENT_LINK)})`

const agentLinkSchema = z.object({
  type: z.literal(AGENT_LINK),
  url: z.url({ protocol: /^https$/u }),
})

/**
 * The https address a message from the file's own frame asks the view to
 * open; `undefined` for a message from anywhere else, of any other shape, or
 * for any other scheme.
 */
export function agentLink(
  { source, data }: { source: MessageEventSource | null; data: unknown },
  frame: MessageEventSource | null | undefined
) {
  return source !== null && source === frame
    ? agentLinkSchema.safeParse(data).data?.url
    : undefined
}

/**
 * The file's HTML with the policy as the first child of its head, so it
 * governs every script the file holds, and the zoom script and the stand-ins
 * after it, so they run before the file's own.
 */
function withPolicy(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html")
  const meta = document.createElement("meta")
  meta.httpEquiv = "Content-Security-Policy"
  meta.content = AGENT_HTML_CSP
  const scripts = [ZOOM_SCRIPT, STAND_INS_SCRIPT].map((source) => {
    const script = document.createElement("script")
    script.textContent = source
    return script
  })
  document.head.prepend(meta, ...scripts)
  return `<!doctype html>${document.documentElement.outerHTML}`
}

/**
 * An HTML file, run with its scripts in a frame of its own, beside its source
 * highlighted as HTML with a Copy of its own, either `height` pixels tall. The tabs between them sit
 * among the view's controls; the arrow keys, Home, and End move between them.
 * A link the file opens goes to `openLink`.
 */
export function HtmlPreview({
  text,
  height,
  labels,
  read,
  openLink,
}: {
  text: string
  height: number
  labels: ViewLabels["artifact"]
  read: ViewApp["readServerResource"]
  openLink: ViewApp["openLink"]
}) {
  const html = useMemo(() => withPolicy(text), [text])
  const [tab, setTab] = useState<(typeof TABS)[number]>("preview")
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const relay = (event: MessageEvent) => {
      const url = agentLink(event, frame.current?.contentWindow)
      if (url !== undefined) void openLink({ url }).catch(() => undefined)
    }
    window.addEventListener("message", relay)
    return () => window.removeEventListener("message", relay)
  }, [openLink])
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
            ref={frame}
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
