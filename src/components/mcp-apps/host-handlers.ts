/**
 * The host's answers to what an App view asks of it, kept pure so each policy
 * is testable without a sandboxed frame.
 */

import type { McpAppFiles } from "@aos/protocol/mcp-apps"
import { presentationViews } from "@shared/presentation/views"

type ContentBlock = { readonly type: string; readonly text?: unknown }

type OpenWindow = (url: string, target: string, features: string) => unknown

/**
 * A view may open a link only in a new, unrelated `https` browsing context.
 * One of its own file addresses, which this page serves, may be `http` as the
 * page itself is served over `http`.
 */
export function openAppLink(
  url: string,
  {
    ownFile = false,
    open = (...args) => window.open(...args),
  }: { ownFile?: boolean; open?: OpenWindow } = {}
): { isError?: true } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { isError: true }
  }
  const secure =
    parsed.protocol === "https:" || (ownFile && parsed.protocol === "http:")
  if (!secure) return { isError: true }
  open(parsed.href, "_blank", "noopener,noreferrer")
  return {}
}

/**
 * Where a file address points, as a CSP source and for comparing addresses:
 * its origin and path, every path segment percent-encoded, without the query
 * that carries its pass; `undefined` for anything but an absolute http(s) URL.
 */
export function fileLocation(address: string): string | undefined {
  try {
    const url = new URL(address)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    const path = url.pathname
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join("/")
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}

/** The argument whose file `url` addresses, whatever pass `url` carries. */
export function fileArgument(
  url: string,
  files: McpAppFiles | undefined
): string | undefined {
  const location = fileLocation(url)
  if (location === undefined || !files) return undefined
  return Object.entries(files.addresses).find(
    ([, address]) => fileLocation(address) === location
  )?.[0]
}

/**
 * The name a download is saved under: the view's name for it, without any
 * directory or any reserved or control character. Empty leaves the name to the
 * browser, which takes the file's own.
 */
export function downloadName(name: string): string {
  const base = name.split(/[/\\]/).at(-1) ?? ""
  return base
    .replace(/[\p{Cc}"*:<>?|]/gu, "_")
    .trim()
    .replace(/^\.+/, "")
}

/**
 * Saves one of the view's own files as a click on a link to it would. Only a
 * same-origin address can be saved under a name of the host's choosing.
 */
export function saveAppFile(address: string, name: string): boolean {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  if (url.origin !== window.location.origin) return false
  const link = document.createElement("a")
  link.href = url.href
  link.download = downloadName(name)
  link.click()
  return true
}

/**
 * The MCP server a tool comes from: `aos-ui` for its bare tools, and
 * `<server>` for any other named `mcp__<server>__<tool>`.
 */
export function mcpToolServer(toolName: string | undefined) {
  if (toolName === undefined) return undefined
  if (Object.hasOwn(presentationViews, toolName)) return "aos-ui"
  return /^mcp__(.+?)__./.exec(toolName)?.[1]
}

/**
 * Shares each `ui://` resource read per Agent and server, a read still in
 * flight included: a view's templates and assets stay put while it runs, and
 * a view that moves reloads and reads them again. It keeps the latest `limit`
 * reads and forgets a failed one; every other resource is read each time.
 */
export function createResourceCache<T>(limit = 64) {
  const reads = new Map<string, Promise<T>>()
  return (
    request: { agentId: string; toolName?: string; uri: string },
    read: () => Promise<T>
  ): Promise<T> => {
    const server = mcpToolServer(request.toolName)
    if (server === undefined || !request.uri.startsWith("ui://")) return read()
    const key = JSON.stringify([request.agentId, server, request.uri])
    const cached = reads.get(key)
    if (cached) return cached
    const pending = read()
    reads.set(key, pending)
    pending.catch(() => {
      if (reads.get(key) === pending) reads.delete(key)
    })
    for (const oldest of reads.keys()) {
      if (reads.size <= limit) break
      reads.delete(oldest)
    }
    return pending
  }
}

/**
 * The text a `ui/message` would send as the operator's next turn, or
 * `undefined` when it carries anything but non-empty text.
 */
export function appMessageText(message: {
  readonly role: string
  readonly content: readonly ContentBlock[]
}): string | undefined {
  if (message.role !== "user" || message.content.length === 0) return undefined
  const texts: string[] = []
  for (const block of message.content) {
    if (block.type !== "text" || typeof block.text !== "string")
      return undefined
    texts.push(block.text)
  }
  const text = texts.join("\n\n").trim()
  return text || undefined
}

/** Admits at most `limit` calls in any `windowMs`; the rest are refused. */
export function createRateLimiter(
  limit = 10,
  windowMs = 1_000,
  now: () => number = Date.now
) {
  const admitted: number[] = []
  return () => {
    const at = now()
    while (at - (admitted[0] ?? at) >= windowMs) admitted.shift()
    if (admitted.length >= limit) return false
    admitted.push(at)
    return true
  }
}

/**
 * The display modes this host can give a view: in its message, covering the
 * viewport, or in the side panel beside the conversation.
 */
const DISPLAY_MODES = ["inline", "fullscreen", "pip"] as const
export type AppDisplayMode = (typeof DISPLAY_MODES)[number]
/** Where a view's frame sits; moving it between the two reloads the view. */
export type AppPlacement = Exclude<AppDisplayMode, "fullscreen">

/** The modes a view is offered: the side panel only where a host shows one. */
export function offeredDisplayModes(
  sidePanel: boolean
): readonly AppDisplayMode[] {
  return sidePanel
    ? DISPLAY_MODES
    : DISPLAY_MODES.filter((mode) => mode !== "pip")
}

/**
 * The mode a `ui/request-display-mode` leaves the view in: the one it asked
 * for when this host offers it and the view declared it among its
 * `availableDisplayModes` (when it declared any), otherwise the one it already
 * had.
 */
export function grantDisplayMode(
  requested: string,
  current: AppDisplayMode,
  offered: readonly AppDisplayMode[],
  declared?: readonly string[]
): AppDisplayMode {
  if (declared && !declared.includes(requested)) return current
  return offered.find((mode) => mode === requested) ?? current
}
