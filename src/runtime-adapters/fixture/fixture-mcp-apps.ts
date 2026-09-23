import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"

import type { McpAppView } from "@aos/protocol/mcp-apps"
import { FIXTURE_AOS_UI_MCP_PATH } from "@shared/presentation/views"

import type { McpAppAdapter } from "../contracts"
import {
  FIXTURE_PRESENTATION_RESULT,
  fixturePresentationCall,
  type FixturePresentationCall,
} from "./fixture-presentations"

export const FIXTURE_MCP_APP_TOOL = "show_launch_board"
const REFRESH_TOOL = "refresh_launch_board"

/**
 * A deterministic App view that speaks the MCP Apps postMessage protocol by
 * hand: it initializes, shows the tool input and result the host sends, calls
 * one app-only tool, sends one `ui/message`, asks for full screen and back,
 * shows the display mode the host reports, and reports its height.
 */
const FIXTURE_APP_HTML = `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; padding: 12px; font: 14px/1.5 var(--font-sans, system-ui);
    color: var(--color-text-primary, #222); background: transparent; }
  pre { margin: 4px 0 8px; white-space: pre-wrap; }
  button { font: inherit; margin-inline-end: 8px; }
</style>
</head>
<body>
<h1 style="font-size: 1rem; margin: 0 0 8px">Launch board</h1>
<p>Input</p><pre id="input">…</pre>
<p>Result</p><pre id="result">…</pre>
<button id="refresh" type="button">Refresh board</button>
<button id="ask" type="button">Ask for a summary</button>
<button id="fullscreen" type="button">Fullscreen</button>
<button id="inline" type="button">Inline view</button>
<p id="mode">…</p>
<p id="status" role="status"></p>
<script>
  let nextId = 1
  const pending = new Map()
  const post = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*")
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      post({ id, method, params })
    })
  const text = (result) =>
    (result?.content ?? []).map((block) => block.text ?? "").join(" ")
  const reportSize = () =>
    post({ method: "ui/notifications/size-changed",
      params: { height: Math.ceil(document.documentElement.scrollHeight) } })
  const show = (id, value) => {
    document.getElementById(id).textContent = value
    reportSize()
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const message = event.data
    if (message?.jsonrpc !== "2.0") return
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      message.error ? reject(message.error) : resolve(message.result)
    } else if (message.method === "ui/notifications/tool-input") {
      show("input", JSON.stringify(message.params.arguments))
    } else if (message.method === "ui/notifications/tool-result") {
      show("result", text(message.params))
    } else if (message.method === "ui/notifications/host-context-changed") {
      if (message.params.displayMode) showMode(message.params.displayMode)
    } else if (message.id !== undefined) {
      post({ id: message.id, result: {} })
    }
  })
  document.getElementById("refresh").addEventListener("click", async () => {
    try {
      show("result", text(await request("tools/call",
        { name: "${REFRESH_TOOL}", arguments: {} })))
    } catch {
      show("status", "Refresh failed")
    }
  })
  const showMode = (mode) => show("mode", "Display mode: " + mode)
  const requestMode = (mode) => () =>
    request("ui/request-display-mode", { mode }).then((result) =>
      showMode(result.mode))
  document.getElementById("fullscreen").addEventListener("click",
    requestMode("fullscreen"))
  document.getElementById("inline").addEventListener("click",
    requestMode("inline"))
  document.getElementById("ask").addEventListener("click", async () => {
    const result = await request("ui/message", { role: "user",
      content: [{ type: "text", text: "Summarize the launch board" }] })
    show("status", result?.isError ? "Message refused" : "Message sent")
  })
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "Fixture launch board", version: "1.0.0" },
    appCapabilities: {},
  }).then((result) => {
    showMode(result.hostContext?.displayMode ?? "inline")
    post({ method: "ui/notifications/initialized", params: {} })
    reportSize()
  })
</script>
</body>
</html>`

type RecordedToolsServer = {
  tools: Array<{ name: string; _meta?: { ui?: { resourceUri?: unknown } } }>
  resources: Record<string, ReadResourceResult>
}

/** The `aos-ui` server's recorded answers, read once per preview. */
function recordedToolsServer(): () => Promise<RecordedToolsServer> {
  let recorded: Promise<RecordedToolsServer> | undefined
  return () =>
    (recorded ??= fetch(FIXTURE_AOS_UI_MCP_PATH).then(async (response) => {
      if (!response.ok) throw new Error("The aos-ui server is not recorded")
      return (await response.json()) as RecordedToolsServer
    })).catch((error: unknown) => {
      recorded = undefined
      throw error
    })
}

/** The view a presentation call's tool declares, as its server serves it. */
async function presentationView(
  server: RecordedToolsServer,
  call: FixturePresentationCall
): Promise<McpAppView> {
  const tool = server.tools.find(({ name }) => name === call.toolName)
  const uri = tool?._meta?.ui?.resourceUri
  const content =
    typeof uri === "string" ? server.resources[uri]?.contents[0] : undefined
  if (!content || !("text" in content))
    throw new Error(`${call.toolName} declares no recorded view`)
  const ui = (content._meta as { ui?: { csp?: McpAppView["csp"] } } | undefined)
    ?.ui
  return {
    html: content.text,
    ...(ui?.csp ? { csp: ui.csp } : {}),
    toolInput: call.args,
    toolResult: {
      content: [
        { type: "text", text: JSON.stringify(FIXTURE_PRESENTATION_RESULT) },
      ],
    },
  }
}

/**
 * Serves the preview's Apps: charts, maps and stats through the real
 * `aos-ui` server's recorded `tools/list` and `resources/read`, and one
 * launch board whose every refresh answers the next numbered board.
 */
export function createFixtureMcpAppAdapter(): McpAppAdapter {
  const server = recordedToolsServer()
  let refreshes = 0
  return {
    async open({ toolCallId }) {
      const presentation = fixturePresentationCall(toolCallId)
      if (presentation) return presentationView(await server(), presentation)
      if (toolCallId !== `fixture-${FIXTURE_MCP_APP_TOOL}`)
        throw new Error("Fixture tool call has no App view")
      return {
        html: FIXTURE_APP_HTML,
        prefersBorder: true,
        toolInput: { board: "launch" },
        toolResult: {
          content: [{ type: "text", text: "3 of 5 launch tasks are done." }],
        },
      }
    },
    async callTool({ name }) {
      if (name !== REFRESH_TOOL)
        return {
          content: [{ type: "text", text: `Unknown tool ${name}` }],
          isError: true,
        }
      refreshes += 1
      return {
        content: [
          {
            type: "text",
            text: `Board refreshed (${refreshes}): 4 of 5 done.`,
          },
        ],
      }
    },
    async readResource({ uri }) {
      const recorded = uri.startsWith("ui://aos-ui/")
        ? (await server()).resources[uri]
        : undefined
      return (
        recorded ?? { contents: [{ uri, mimeType: "text/plain", text: "" }] }
      )
    },
  }
}
