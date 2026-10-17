import { describe, expect, it } from "vitest"

import {
  AGENT_LINK,
  agentLink,
  installStandIns,
  type AgentWindow,
} from "./html-preview"

/**
 * A window in an opaque origin, whose storage throws on access; `posted`
 * holds what it sends its parent.
 */
function sandboxedPage() {
  const posted: unknown[] = []
  const refused = (): Storage => {
    throw new DOMException("The document is sandboxed", "SecurityError")
  }
  const page: AgentWindow = {
    get localStorage() {
      return refused()
    },
    get sessionStorage() {
      return refused()
    },
    addEventListener() {},
    open: () => null,
    parent: { postMessage: (message: unknown) => void posted.push(message) },
  }
  return { page, posted }
}

describe("installStandIns", () => {
  it("stores and reads values in memory where the browser's storage throws", () => {
    const { page } = sandboxedPage()
    expect(() => page.localStorage).toThrow("sandboxed")

    installStandIns(page, AGENT_LINK)
    const { localStorage, sessionStorage } = page
    localStorage.setItem("ticks", "[1,3]")
    localStorage.setItem("theme", "dark")
    expect(localStorage.getItem("ticks")).toBe("[1,3]")
    expect(localStorage.getItem("unset")).toBeNull()
    expect(localStorage).toHaveLength(2)
    expect(localStorage.key(1)).toBe("theme")
    expect(localStorage.key(2)).toBeNull()
    localStorage.removeItem("ticks")
    expect(localStorage.getItem("ticks")).toBeNull()
    expect(sessionStorage.getItem("theme")).toBeNull()
    sessionStorage.setItem("step", "2")
    localStorage.clear()
    expect(localStorage).toHaveLength(0)
    expect(sessionStorage.getItem("step")).toBe("2")
  })

  it("sends window.open's https address to the view and opens nothing itself", () => {
    const { page, posted } = sandboxedPage()
    installStandIns(page, AGENT_LINK)

    expect(page.open("https://example.invalid/report")).toBeNull()
    page.open("http://example.invalid/report")
    page.open("javascript:alert(1)")
    page.open("report.html")
    expect(posted).toEqual([
      { type: AGENT_LINK, url: "https://example.invalid/report" },
    ])
  })
})

describe("agentLink", () => {
  const { port1: frame, port2: elsewhere } = new MessageChannel()
  const link = { type: AGENT_LINK, url: "https://example.invalid/report" }

  it("opens the https address the view's own file frame sends", () => {
    expect(agentLink({ source: frame, data: link }, frame)).toBe(
      "https://example.invalid/report"
    )
  })

  const from = (data: unknown) => ({ source: frame, data })

  it.each([
    ["a message from another frame", { source: elsewhere, data: link }, frame],
    ["a sourceless message with no frame", { source: null, data: link }, null],
    ["a URL that is not a string", from({ ...link, url: 1 }), frame],
    ["an http URL", from({ ...link, url: "http://example.invalid/" }), frame],
    ["a javascript: URL", from({ ...link, url: "javascript:alert(1)" }), frame],
    ["a data: URL", from({ ...link, url: "data:text/html,hi" }), frame],
    ["another message type", from({ ...link, type: "ui/open-link" }), frame],
  ])("ignores %s", (_, message, ownFrame) => {
    expect(agentLink(message, ownFrame)).toBeUndefined()
  })
})
