import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiDisplayMode,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { useSyncExternalStore, type ComponentType } from "react"
import { createRoot } from "react-dom/client"
import type { z } from "zod"

import type { PresentationViewName } from "../../../shared/presentation/views"
import {
  VIEW_LABELS,
  viewLocale,
  type ViewLabels,
  type ViewLocale,
} from "./locale"
import { rateLimited } from "./rate-limit"
import "./styles.css"

/**
 * The requests a view sends its page, and `fitWidth`, the width in CSS pixels
 * the view takes in its message, or `undefined` to fill it.
 */
export type ViewApp = Pick<
  App,
  "readServerResource" | "downloadFile" | "openLink" | "requestDisplayMode"
> & { fitWidth: (width: number | undefined) => void }

export type ViewProps<T> = {
  value: T
  labels: ViewLabels
  locale: ViewLocale
  app: ViewApp
  /** What the page last reported, merged; a view reads its own keys from it. */
  context?: McpUiHostContext
}

const FALLBACK_MARKER = "Structured fallback:\n"

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * What a result carries for its view: the server's `structuredContent.value`,
 * or the JSON its text fallback ends with. A harness that forwards only text
 * still reaches the view this way.
 */
export function resultValue(result: CallToolResult | undefined): unknown {
  if (!result) return undefined
  const structured = result.structuredContent as { value?: unknown } | undefined
  if (structured?.value !== undefined) return structured.value
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue
    const marker = block.text.lastIndexOf(FALLBACK_MARKER)
    const value = parseJson(
      marker === -1
        ? block.text
        : block.text.slice(marker + FALLBACK_MARKER.length)
    )
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * What the result carries when it is valid, else the tool input. The input
 * draws while the call runs; the server's own result then replaces it, since
 * the page withholds every argument that starts with `/` from the input.
 */
export function presentationValue<T>(
  schema: z.ZodType<T>,
  input: unknown,
  result: CallToolResult | undefined
): T | undefined {
  for (const candidate of [resultValue(result), input]) {
    if (candidate === undefined) continue
    const parsed = schema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  return undefined
}

/**
 * Applies what the host reported: theme, style variables, fonts, safe-area
 * insets, language and direction. The insets are physical pixels, so `right`
 * and `left` stay physical in either direction.
 */
function applyHostContext(
  root: HTMLElement,
  context: McpUiHostContext | undefined
) {
  if (context?.theme) applyDocumentTheme(context.theme)
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables)
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts)
  const insets = context?.safeAreaInsets
  if (insets)
    root.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`
  const locale = viewLocale(context?.locale)
  document.documentElement.lang = locale
  document.documentElement.dir = locale === "he" ? "rtl" : "ltr"
  return locale
}

/**
 * Reports the document's height as it changes, as the SDK's `autoResize`
 * measures it, with the width the view fits, if any.
 */
function sizeReporter(app: App) {
  let width: number | undefined
  let started = false
  let pending = false
  let sent: { width?: number; height: number } | undefined
  const report = () => {
    if (!started || pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      const root = document.documentElement
      const previous = root.style.height
      root.style.height = "max-content"
      const height = Math.ceil(root.getBoundingClientRect().height)
      root.style.height = previous
      if (sent?.height === height && sent.width === width) return
      sent = { height, ...(width === undefined ? {} : { width }) }
      void app.sendSizeChanged(sent).catch(() => undefined)
    })
  }
  return {
    start() {
      started = true
      const observer = new ResizeObserver(report)
      observer.observe(document.documentElement)
      observer.observe(document.body)
      report()
    },
    fitWidth(next: number | undefined) {
      const rounded = next === undefined ? undefined : Math.ceil(next)
      if (rounded === width) return
      width = rounded
      report()
    },
  }
}

type ViewState = {
  locale: ViewLocale
  context?: McpUiHostContext
  input?: unknown
  result?: CallToolResult
  settled: boolean
  cancelled: boolean
}

type ViewStore = {
  subscribe: (listener: () => void) => () => void
  getState: () => ViewState
}

function ViewRoot<T>({
  store,
  schema,
  View,
  app,
}: {
  store: ViewStore
  schema: z.ZodType<T>
  View: ComponentType<ViewProps<T>>
  app: ViewApp
}) {
  const { locale, context, input, result, settled, cancelled } =
    useSyncExternalStore(store.subscribe, store.getState)
  const labels = VIEW_LABELS[locale]
  const value = cancelled ? undefined : presentationValue(schema, input, result)
  if (value !== undefined)
    return (
      <View
        value={value}
        labels={labels}
        locale={locale}
        app={app}
        context={context}
      />
    )
  // An input that does not parse may still be followed by a result that does.
  return (
    <p className="p-3 text-sm text-muted-foreground" role="status">
      {cancelled ? labels.cancelled : settled ? labels.invalid : labels.waiting}
    </p>
  )
}

/**
 * Mounts one presentation view: it connects to the host over `postMessage`,
 * renders from the tool input as soon as the host sends it, then from the
 * result's structured value once one arrives, and reports every size change:
 * its height, and its width only once it fits one of its own, since a frame
 * that hugged an echo of its own width could never grow back.
 * Every handler is set before `connect` so no notification is missed.
 */
export function startView<T>(
  name: PresentationViewName,
  schema: z.ZodType<T>,
  View: ComponentType<ViewProps<T>>,
  displayModes: McpUiDisplayMode[] = ["inline"]
) {
  const root = document.getElementById("root")
  if (!root) throw new Error("The view document has no root")
  const app = new App(
    { name: `aos-ui-${name}`, version: "1.0.0" },
    { availableDisplayModes: displayModes },
    { autoResize: false }
  )
  const reportSize = sizeReporter(app)
  const viewApp: ViewApp = {
    readServerResource: rateLimited((params) => app.readServerResource(params)),
    downloadFile: (params) => app.downloadFile(params),
    openLink: (params) => app.openLink(params),
    requestDisplayMode: (params) => app.requestDisplayMode(params),
    fitWidth: reportSize.fitWidth,
  }
  let state: ViewState = {
    locale: applyHostContext(root, undefined),
    settled: false,
    cancelled: false,
  }
  const listeners = new Set<() => void>()
  const update = (next: Partial<ViewState>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const store: ViewStore = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getState: () => state,
  }
  const refresh = () => {
    const context = app.getHostContext()
    update({ context, locale: applyHostContext(root, context) })
  }
  const reactRoot = createRoot(root)
  app.ontoolinput = ({ arguments: input }) => update({ input })
  app.ontoolresult = (result) => update({ result, settled: true })
  app.ontoolcancelled = () => update({ settled: true, cancelled: true })
  app.onhostcontextchanged = refresh
  app.onteardown = () => {
    reactRoot.unmount()
    listeners.clear()
    return {}
  }
  reactRoot.render(
    <ViewRoot store={store} schema={schema} View={View} app={viewApp} />
  )
  void app.connect(new PostMessageTransport(window.parent, window.parent)).then(
    () => {
      refresh()
      reportSize.start()
    },
    () => undefined
  )
}
