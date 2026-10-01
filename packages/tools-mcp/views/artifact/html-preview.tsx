import { useMemo, useState } from "react"

import type { ViewLabels } from "../locale"
import { Tabs } from "../ui/tabs"

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
 * The file's HTML with the policy as the first child of its head, so it
 * governs every script the file holds. The page's `injectHtmlCsp` does the
 * same for a view; the view cannot import the page's code.
 */
function withPolicy(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html")
  const meta = document.createElement("meta")
  meta.httpEquiv = "Content-Security-Policy"
  meta.content = AGENT_HTML_CSP
  document.head.prepend(meta)
  return `<!doctype html>${document.documentElement.outerHTML}`
}

/**
 * An HTML file, run with its scripts in a frame of its own, beside its source
 * as text, both `height` pixels tall with the tabs. The arrow keys, Home,
 * and End move between the two tabs.
 */
export function HtmlPreview({
  text,
  height,
  labels,
}: {
  text: string
  height: number
  labels: ViewLabels["artifact"]
}) {
  const html = useMemo(() => withPolicy(text), [text])
  const [tab, setTab] = useState<(typeof TABS)[number]>("preview")
  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      <Tabs
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
          <pre
            dir="ltr"
            tabIndex={0}
            className="m-0 h-full overflow-auto rounded-md bg-muted p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {text}
          </pre>
        )}
      </Tabs>
    </div>
  )
}
