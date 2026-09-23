import { afterEach, describe, expect, it, vi } from "vitest"

import RELAY from "../../../public/mcp-app-sandbox.js?raw"

type Listener = (event: { source: unknown; data: unknown }) => void

/** Runs the relay page's script against a stand-in host window. */
function startRelay() {
  const host = { postMessage: vi.fn() }
  let listener: Listener | undefined
  const page = {
    parent: host,
    addEventListener: (type: string, next: Listener) => {
      if (type === "message") listener = next
    },
  }
  new Function("window", "document", "location", "URLSearchParams", RELAY)(
    page,
    document,
    { search: "" },
    URLSearchParams
  )
  const fromHost = (data: unknown) => listener?.({ source: host, data })
  fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-resource-ready",
    params: { html: "<p>app</p>" },
  })
  const frame = document.querySelector("iframe")
  if (!frame?.contentWindow) throw new Error("The relay made no App frame")
  const toApp = vi.spyOn(frame.contentWindow, "postMessage")
  const fromApp = (data: unknown) =>
    listener?.({ source: frame.contentWindow, data })
  return { host, fromHost, fromApp, toApp }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe("MCP App sandbox relay", () => {
  it("announces itself to the host", () => {
    const { host } = startRelay()
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "ui/notifications/sandbox-proxy-ready",
      }),
      "*"
    )
  })

  it("forwards host messages to the view but keeps sandbox ones", () => {
    const { fromHost, toApp } = startRelay()
    const input = {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: {} },
    }
    fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-anything",
      params: {},
    })
    fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<p>again</p>" },
    })
    fromHost(input)
    expect(toApp.mock.calls).toEqual([[input, "*"]])
    expect(document.querySelectorAll("iframe")).toHaveLength(1)
  })

  it("forwards view messages to the host but keeps sandbox ones", () => {
    const { host, fromApp } = startRelay()
    host.postMessage.mockClear()
    const initialized = {
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    }
    fromApp({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-proxy-ready",
    })
    fromApp(initialized)
    expect(host.postMessage.mock.calls).toEqual([[initialized, "*"]])
  })
})
