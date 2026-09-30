import { useId, useRef, useState, type KeyboardEvent } from "react"

import type { ViewLabels } from "../locale"

type Tab = "preview" | "source"

const TABS: Tab[] = ["preview", "source"]

const other = (tab: Tab): Tab => (tab === "preview" ? "source" : "preview")

/** The tab each key moves to; with two tabs, either arrow wraps to the other. */
const TAB_KEYS: Partial<Record<string, (tab: Tab) => Tab>> = {
  ArrowLeft: other,
  ArrowRight: other,
  Home: () => "preview",
  End: () => "source",
}

const TAB_CLASS =
  "cursor-pointer rounded-sm px-3 py-1 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-selected:bg-background aria-selected:text-foreground motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"

/**
 * An HTML file, drawn with none of its scripts, beside its source as text.
 * The arrow keys, Home, and End move between the two tabs.
 */
export function HtmlPreview({
  text,
  labels,
}: {
  text: string
  labels: ViewLabels["artifact"]
}) {
  const [tab, setTab] = useState<Tab>("preview")
  const id = useId()
  const buttons = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
  const move = (event: KeyboardEvent) => {
    const to = TAB_KEYS[event.key]
    if (!to) return
    event.preventDefault()
    const next = to(tab)
    setTab(next)
    buttons.current[next]?.focus()
  }
  return (
    <div className="flex flex-col gap-2">
      <div
        role="tablist"
        aria-label={labels.htmlView}
        className="inline-flex w-fit gap-1 rounded-md bg-muted p-1"
        onKeyDown={move}
      >
        {TABS.map((name) => (
          <button
            key={name}
            ref={(button) => {
              buttons.current[name] = button
            }}
            id={`${id}-${name}`}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls={`${id}-panel`}
            tabIndex={tab === name ? 0 : -1}
            className={TAB_CLASS}
            onClick={() => setTab(name)}
          >
            {labels[name]}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
        {tab === "preview" ? (
          // An empty sandbox runs none of the file's scripts and gives it an
          // opaque origin, so it reaches neither this view nor the page.
          <iframe
            sandbox=""
            srcDoc={text}
            title={labels.htmlTitle}
            className="h-96 w-full rounded-md border bg-white"
          />
        ) : (
          <pre
            dir="ltr"
            tabIndex={0}
            className="m-0 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {text}
          </pre>
        )}
      </div>
    </div>
  )
}
