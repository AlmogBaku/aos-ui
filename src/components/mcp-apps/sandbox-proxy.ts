import { injectHtmlCsp } from "@/components/artifacts/artifact-frame-policy"
import { MCP_APP_SANDBOX_PATH } from "@aos/protocol/mcp-apps"

/**
 * MCP Apps render behind a double iframe. The outer sandbox proxy is a static
 * page (`public/mcp-app-sandbox.html`) loaded with an opaque origin and no
 * power beyond scripts; it holds only a relay, which creates the inner App
 * frame once the host hands it the view's HTML
 * (`ui/notifications/sandbox-resource-ready`) and then forwards messages
 * between the host and that frame alone. Neither frame may navigate the top
 * window, open popups, or submit forms.
 */
export const SANDBOX_PROXY_SANDBOX = "allow-scripts"

/** The sandbox proxy page, told which features the App frame may use. */
export const sandboxProxyUrl = (allow: string) =>
  allow
    ? `${MCP_APP_SANDBOX_PATH}?${new URLSearchParams({ allow })}`
    : MCP_APP_SANDBOX_PATH

/**
 * The host sizes an inline view to its reported height, so its root never
 * shows a scroll track; a view taller than the host's cap still scrolls.
 */
const APP_ROOT_STYLE =
  ":root{scrollbar-width:none}:root::-webkit-scrollbar{display:none}"

/**
 * The view's HTML with the sandbox policy in force, the host's scrollbar rule,
 * and the operator's language and direction on its root unless the App
 * declared its own: the host context carries a locale but no direction.
 */
export function prepareAppDocument(
  html: string,
  { csp, lang, dir }: { csp: string; lang: string; dir: "ltr" | "rtl" }
): string {
  return injectHtmlCsp(html, csp, (document) => {
    const root = document.documentElement
    const style = document.createElement("style")
    style.textContent = APP_ROOT_STYLE
    // After the policy, before the view's own styles, which may override it.
    document.head
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.after(style)
    if (!root.hasAttribute("lang")) root.setAttribute("lang", lang)
    if (!root.hasAttribute("dir")) root.setAttribute("dir", dir)
  })
}
