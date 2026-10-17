import type { LaneOrigins } from "@shared/lane-origins"

/**
 * MCP Apps render behind a double iframe, as the spec's sandbox proxy does.
 * The outer frame is a static page (`public/mcp-app-sandbox.html`) on the
 * lane's own sandbox origin, apart from its pages' origins, under the view's
 * own policy as its header; it holds only a relay, which creates the inner App
 * frame once the host hands it the view's HTML
 * (`ui/notifications/sandbox-resource-ready`) and then forwards messages
 * between the host and that frame alone. The view runs on the sandbox origin,
 * with storage of its own, and neither frame may navigate the top window, open
 * popups, or submit forms.
 */
export const SANDBOX_PROXY_SANDBOX = "allow-scripts allow-same-origin"

/**
 * Whether views may show on a page at `pageOrigin`: one of its lane's own
 * origins, and never its sandbox's.
 */
export const showsViewsAt = (
  origins: LaneOrigins | undefined,
  pageOrigin: string
): origins is LaneOrigins =>
  origins !== undefined &&
  origins.publicOrigins.includes(pageOrigin) &&
  origins.mcpAppSandboxOrigin !== pageOrigin

/**
 * The host sizes an inline view to its reported height, so its root never
 * shows a scroll track; a view taller than the host's cap still scrolls.
 */
const APP_ROOT_STYLE =
  ":root{scrollbar-width:none}:root::-webkit-scrollbar{display:none}"

/**
 * The view's HTML with the host's scrollbar rule, and the operator's language
 * and direction on its root unless the App declared its own: the host context
 * carries a locale but no direction. The view's frame inherits its sandbox
 * page's policy, so the document carries none of its own.
 */
export function prepareAppDocument(
  html: string,
  { lang, dir }: { lang: string; dir: "ltr" | "rtl" }
): string {
  const document = new DOMParser().parseFromString(html, "text/html")
  const root = document.documentElement
  const style = document.createElement("style")
  style.textContent = APP_ROOT_STYLE
  // Before the view's own styles, which may override it.
  document.head.prepend(style)
  if (!root.hasAttribute("lang")) root.setAttribute("lang", lang)
  if (!root.hasAttribute("dir")) root.setAttribute("dir", dir)
  return `<!doctype html>${root.outerHTML}`
}
