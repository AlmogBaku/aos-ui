import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { z } from "zod"

import {
  AGENT_HTML_DOMAINS,
  ARTIFACT_VIEW_HOST_META,
} from "../../../../shared/presentation/views"
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
 * the life of the preview. Where the view keeps the file's storage, on its
 * stable origin (`agentStorage`), `localStorage` instead starts from what the
 * view saved for the file and posts an `aos/storage` message after each
 * change, which the view saves. `https:` link clicks and `window.open`
 * calls post an `aos/openLink` message to the view (via `parent.postMessage`);
 * the view calls `ui/open-link` to open the URL in the workspace.
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

/**
 * The message the file's frame sends the view after each change to its
 * `localStorage`, with every value it then holds.
 */
export const AGENT_STORAGE = "aos/storage"

/**
 * The most one file's saved values may take, as the length of their JSON: a
 * small share of the few megabytes a browser keeps for one origin, which the
 * artifact view's stable origin shares among every file it saves.
 */
export const AGENT_STORAGE_LIMIT = 64 * 1024

/** A file's saved `localStorage` values, by key. */
export type SavedItems = Record<string, string>

const savedItemsSchema = z.record(z.string(), z.string())

/** What the stand-ins replace and reach in the file's window. */
export type AgentWindow = Pick<
  Window,
  "localStorage" | "sessionStorage" | "addEventListener" | "open"
> & { parent: Pick<Window, "postMessage"> }

/** The messages the stand-ins send, and what the file's storage starts from. */
export type StandInOptions = {
  linkType: string
  storageType: string
  /** Whether the view keeps the file's `localStorage`, from `saved` on. */
  persists: boolean
  /** The file's saved values, which a kept `localStorage` starts with. */
  saved: SavedItems
  /** The longest JSON a kept `localStorage`'s values may take. */
  limit: number
}

/**
 * Stands in for what the file's opaque origin takes from it. Web storage
 * lives in memory for the life of the preview. Where the view `persists` the
 * file's `localStorage`, it starts from `saved` instead and, after each
 * change, sends the view every value it holds as a `storageType` message; a
 * change that would take their JSON past `limit` throws as a full storage
 * does and changes nothing. A click on an https link the page left to the
 * browser, and `window.open` with an https address, go up to the view as a
 * `linkType` message; any other address stays the page's own. The file's
 * frame runs it from its source, so it reaches nothing outside itself.
 */
export function installStandIns(
  page: AgentWindow,
  { linkType, storageType, persists, saved, limit }: StandInOptions
) {
  // As the standard does, it keeps every key and value as a string. `keep`
  // sees each change before it takes effect, and refuses it by throwing.
  const memory = (
    initial: Iterable<[string, string]>,
    keep: (items: Map<string, string>) => void
  ) => {
    let items = new Map(initial)
    const change = (edit: (next: Map<string, string>) => void) => {
      const next = new Map(items)
      edit(next)
      keep(next)
      items = next
    }
    return {
      get length() {
        return items.size
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(String(key)) ?? null,
      setItem: (key: string, value: string) =>
        change((next) => next.set(String(key), String(value))),
      removeItem: (key: string) => change((next) => next.delete(String(key))),
      clear: () => change((next) => next.clear()),
    }
  }
  const send = (next: Map<string, string>) => {
    const items = Object.fromEntries(next)
    if (JSON.stringify(items).length > limit)
      throw new DOMException(
        "This file's share of storage is full",
        "QuotaExceededError"
      )
    page.parent.postMessage({ type: storageType, items }, "*")
  }
  const inMemory = () => memory([], () => undefined)
  Object.defineProperties(page, {
    localStorage: {
      value: persists ? memory(Object.entries(saved), send) : inMemory(),
    },
    sessionStorage: { value: inMemory() },
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

/**
 * The stand-ins as the file's frame runs them, on its own window, from what
 * `storage` holds for the file, if the view keeps it, with `<` escaped so that
 * no value closes the script.
 */
function standInsScript(storage: AgentStorage | undefined) {
  const options: StandInOptions = {
    linkType: AGENT_LINK,
    storageType: AGENT_STORAGE,
    persists: storage !== undefined,
    saved: storage?.load() ?? {},
    limit: AGENT_STORAGE_LIMIT,
  }
  return `(${installStandIns.toString()})(window, ${JSON.stringify(options).replaceAll("<", "\\u003c")})`
}

const agentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(AGENT_LINK),
    url: z.url({ protocol: /^https$/u }),
  }),
  z.object({ type: z.literal(AGENT_STORAGE), items: savedItemsSchema }),
])

/**
 * What a message from the file's own frame asks of the view: to open an https
 * address, or to save the file's values; `undefined` for a message from
 * anywhere else, of any other shape, or for any other scheme.
 */
export function agentMessage(
  { source, data }: { source: MessageEventSource | null; data: unknown },
  frame: MessageEventSource | null | undefined
) {
  return source !== null && source === frame
    ? agentMessageSchema.safeParse(data).data
    : undefined
}

/** A file's id, as its result carries it: `artifactFileId` of its path. */
const FILE_ID = /^[0-9a-f]{16}$/u

/**
 * Where the view saves each file's values: one key per file, apart from any
 * key the view keeps for itself.
 */
const SAVED_KEY_PREFIX = "aos-ui:agent-html:"

/** One file's saved values, in the view's own storage. */
export type AgentStorage = {
  /** What was saved for the file, or nothing when none can be read. */
  load: () => SavedItems
  /**
   * Saves `items` when their JSON fits the limit. A full storage fails this
   * write alone: nothing else saved is evicted.
   */
  save: (items: SavedItems) => void
}

/** The host an origin names, lowercase; `undefined` for an opaque one. */
function hostOf(origin: string) {
  try {
    return new URL(origin).host
  } catch {
    return undefined
  }
}

/**
 * Where the file `fileId`, its own result's, keeps its values: under its own
 * key in the view's `localStorage`, only while the view's origin has exactly
 * `expectedHost`, the stable host the tools server named in its HTML, as DNS
 * compares names, never by its tail or a pattern. The view's document runs
 * from its frame's `srcdoc`, so its origin, not its location, names its
 * host. Anywhere else, and for a result without a `fileId`, it has none, and
 * the file keeps its values in memory for the life of its frame.
 */
export function agentStorage(
  view: { origin: string; localStorage: Pick<Storage, "getItem" | "setItem"> },
  fileId: string | undefined,
  expectedHost: string | undefined,
  limit = AGENT_STORAGE_LIMIT
): AgentStorage | undefined {
  if (
    fileId === undefined ||
    !FILE_ID.test(fileId) ||
    expectedHost === undefined ||
    hostOf(view.origin) !== expectedHost.toLowerCase()
  )
    return undefined
  const key = `${SAVED_KEY_PREFIX}${fileId}`
  return {
    load: () => {
      try {
        return savedItemsSchema.parse(
          JSON.parse(view.localStorage.getItem(key) ?? "{}")
        )
      } catch {
        return {}
      }
    },
    save: (items) => {
      const text = JSON.stringify(items)
      if (text.length > limit) return
      try {
        view.localStorage.setItem(key, text)
      } catch {
        // Full: this write fails, and what is saved stays as it was.
      }
    },
  }
}

/** The host the tools server named in the view's HTML, if it named one. */
function expectedHost() {
  return (
    document
      .querySelector(`meta[name="${ARTIFACT_VIEW_HOST_META}"]`)
      ?.getAttribute("content") ?? undefined
  )
}

/**
 * The file's HTML with the policy as the first child of its head, so it
 * governs every script the file holds, and the zoom script and the stand-ins,
 * holding what `storage` saved for the file, after it, so they run before the
 * file's own.
 */
function withPolicy(html: string, storage: AgentStorage | undefined) {
  const document = new DOMParser().parseFromString(html, "text/html")
  const meta = document.createElement("meta")
  meta.httpEquiv = "Content-Security-Policy"
  meta.content = AGENT_HTML_CSP
  const scripts = [ZOOM_SCRIPT, standInsScript(storage)].map((source) => {
    const script = document.createElement("script")
    script.textContent = source
    return script
  })
  document.head.prepend(meta, ...scripts)
  return `<!doctype html>${document.documentElement.outerHTML}`
}

/**
 * The file's frame, which runs it with its scripts. It takes the file's saved
 * values as it mounts, again each time Preview shows after Source, and never
 * on a write, which the frame already holds, so a write never reloads it.
 */
function AgentFrame({
  frame,
  text,
  storage,
  title,
}: {
  frame: RefObject<HTMLIFrameElement | null>
  text: string
  storage: AgentStorage | undefined
  title: string
}) {
  const html = useMemo(() => withPolicy(text, storage), [text, storage])
  return (
    // Scripts without the same origin: the file runs in an opaque origin of
    // its own, so it reaches neither this view nor the page.
    <iframe
      ref={frame}
      sandbox="allow-scripts"
      srcDoc={html}
      title={title}
      referrerPolicy="no-referrer"
      className="block h-full w-full rounded-md border bg-white"
    />
  )
}

/**
 * An HTML file, run with its scripts in a frame of its own, beside its source
 * highlighted as HTML with a Copy of its own, either `height` pixels tall. The tabs between them sit
 * among the view's controls; the arrow keys, Home, and End move between them.
 * A link the file opens goes to `openLink`; the values it stores are saved
 * under `fileId` where `agentStorage` keeps them.
 */
export function HtmlPreview({
  text,
  fileId,
  height,
  labels,
  read,
  openLink,
}: {
  text: string
  fileId: string | undefined
  height: number
  labels: ViewLabels["artifact"]
  read: ViewApp["readServerResource"]
  openLink: ViewApp["openLink"]
}) {
  const storage = useMemo(
    () => agentStorage(window, fileId, expectedHost()),
    [fileId]
  )
  const [tab, setTab] = useState<(typeof TABS)[number]>("preview")
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const relay = (event: MessageEvent) => {
      const message = agentMessage(event, frame.current?.contentWindow)
      if (message?.type === AGENT_LINK)
        void openLink({ url: message.url }).catch(() => undefined)
      else if (message?.type === AGENT_STORAGE) storage?.save(message.items)
    }
    window.addEventListener("message", relay)
    return () => window.removeEventListener("message", relay)
  }, [openLink, storage])
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
          <AgentFrame
            frame={frame}
            text={text}
            storage={storage}
            title={labels.htmlTitle}
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
