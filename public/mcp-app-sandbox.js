/* global window, document, location, URLSearchParams */
// The MCP App sandbox proxy relay (see src/components/mcp-apps/sandbox-proxy.ts).
// It creates the App frame once the host hands it the view's HTML, then
// forwards messages between the host and that frame alone. The host names the
// frame's `allow` features in this page's query. The page follows the host
// context's theme, so neither frame paints an opaque canvas behind the view.
;(() => {
  const host = window.parent
  const allow = new URLSearchParams(location.search).get("allow")
  let app
  const followTheme = (context) => {
    const theme = context && context.theme
    if (theme === "light" || theme === "dark")
      document.documentElement.style.colorScheme = theme
  }
  window.addEventListener("message", (event) => {
    const data = event.data
    // Sandbox notifications are between the host and this relay alone, so none
    // crosses to the other side in either direction.
    const sandboxOnly =
      typeof data?.method === "string" &&
      data.method.startsWith("ui/notifications/sandbox-")
    if (event.source === host) {
      if (data?.method === "ui/notifications/sandbox-resource-ready") {
        if (app || typeof data.params?.html !== "string") return
        app = document.createElement("iframe")
        app.setAttribute("sandbox", "allow-scripts allow-same-origin")
        if (allow) app.setAttribute("allow", allow)
        app.setAttribute("title", document.title)
        app.srcdoc = data.params.html
        document.body.append(app)
        return
      }
      if (sandboxOnly) return
      followTheme(
        data?.method === "ui/notifications/host-context-changed"
          ? data.params
          : data?.result?.hostContext
      )
      app?.contentWindow?.postMessage(data, "*")
    } else if (app && event.source === app.contentWindow && !sandboxOnly) {
      host.postMessage(data, "*")
    }
  })
  host.postMessage(
    {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-proxy-ready",
      params: {},
    },
    "*"
  )
})()
