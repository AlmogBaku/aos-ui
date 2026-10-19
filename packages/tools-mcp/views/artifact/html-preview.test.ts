import { describe, expect, it } from "vitest"

import { FIXTURE_ARTIFACT_VIEW_DOMAIN } from "../../../../shared/presentation/views"
import {
  AGENT_LINK,
  AGENT_STORAGE,
  agentMessage,
  agentStorage,
  installStandIns,
  type AgentStorage,
  type AgentWindow,
  type StandInOptions,
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

/** The longest JSON a kept `localStorage` holds here. */
const LIMIT = 64

/**
 * The stand-ins as the view starts them: where it `persists` the file's
 * storage, from `saved`, capped at `LIMIT`.
 */
function standIns(persists: boolean, saved = {}): StandInOptions {
  return {
    linkType: AGENT_LINK,
    storageType: AGENT_STORAGE,
    persists,
    saved,
    limit: LIMIT,
  }
}

describe("installStandIns", () => {
  it("stores and reads values in memory where the browser's storage throws, without a cap, sending the view nothing", () => {
    const { page, posted } = sandboxedPage()
    expect(() => page.localStorage).toThrow("sandboxed")

    installStandIns(page, standIns(false))
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
    localStorage.setItem("notes", "x".repeat(LIMIT))
    expect(localStorage.getItem("notes")).toHaveLength(LIMIT)
    expect(posted).toEqual([])
  })

  it("starts localStorage from the file's saved values and sends the view all of them after each change, and sessionStorage nothing", () => {
    const { page, posted } = sandboxedPage()
    installStandIns(page, standIns(true, { ticks: "[1]" }))

    expect(page.localStorage.getItem("ticks")).toBe("[1]")
    page.localStorage.setItem("theme", "dark")
    page.sessionStorage.setItem("step", "2")
    page.localStorage.removeItem("ticks")
    expect(posted).toEqual([
      { type: AGENT_STORAGE, items: { ticks: "[1]", theme: "dark" } },
      { type: AGENT_STORAGE, items: { theme: "dark" } },
    ])
  })

  it("refuses a write past the file's share as a full storage does, keeping what it held", () => {
    const { page, posted } = sandboxedPage()
    installStandIns(page, standIns(true, { ticks: "[1]" }))

    expect(() => page.localStorage.setItem("notes", "x".repeat(LIMIT))).toThrow(
      expect.objectContaining({ name: "QuotaExceededError" })
    )
    expect(page.localStorage.getItem("notes")).toBeNull()
    expect(page.localStorage.getItem("ticks")).toBe("[1]")
    expect(posted).toEqual([])
  })

  it("sends window.open's https address to the view and opens nothing itself", () => {
    const { page, posted } = sandboxedPage()
    installStandIns(page, standIns(false))

    expect(page.open("https://example.invalid/report")).toBeNull()
    page.open("http://example.invalid/report")
    page.open("javascript:alert(1)")
    page.open("report.html")
    expect(posted).toEqual([
      { type: AGENT_LINK, url: "https://example.invalid/report" },
    ])
  })
})

describe("agentMessage", () => {
  const { port1: frame, port2: elsewhere } = new MessageChannel()
  const link = { type: AGENT_LINK, url: "https://example.invalid/report" }
  const storage = { type: AGENT_STORAGE, items: { ticks: "[1,3]" } }

  it.each([
    ["opens the https address", link],
    ["saves the values", storage],
  ])("%s the view's own file frame sends", (_case, data) => {
    expect(agentMessage({ source: frame, data }, frame)).toEqual(data)
  })

  const from = (data: unknown) => ({ source: frame, data })

  it.each([
    ["a message from another frame", { source: elsewhere, data: link }, frame],
    ["values from another frame", { source: elsewhere, data: storage }, frame],
    ["a sourceless message with no frame", { source: null, data: link }, null],
    ["a URL that is not a string", from({ ...link, url: 1 }), frame],
    ["an http URL", from({ ...link, url: "http://example.invalid/" }), frame],
    ["a javascript: URL", from({ ...link, url: "javascript:alert(1)" }), frame],
    ["a data: URL", from({ ...link, url: "data:text/html,hi" }), frame],
    [
      "a value that is not a string",
      from({ ...storage, items: { a: 1 } }),
      frame,
    ],
    ["another message type", from({ ...link, type: "ui/open-link" }), frame],
  ])("ignores %s", (_, message, ownFrame) => {
    expect(agentMessage(message, ownFrame)).toBeUndefined()
  })
})

describe("agentStorage", () => {
  const DOMAIN = FIXTURE_ARTIFACT_VIEW_DOMAIN
  const HOST = `${DOMAIN}:3917`
  const REPORT = "31f870e8fd4a5d2e"
  const OTHER = "19ca46590f90e9d6"

  /** One origin's browser storage, which refuses every write once `full`. */
  function originStorage() {
    const items = new Map<string, string>()
    return {
      full: false,
      getItem: (key: string) => items.get(key) ?? null,
      setItem(key: string, value: string) {
        if (this.full)
          throw new DOMException(
            "The quota has been exceeded",
            "QuotaExceededError"
          )
        items.set(key, value)
      },
    }
  }

  /** The view on its stable host, the one the tools server named. */
  function stableView() {
    return { origin: `http://${HOST}`, localStorage: originStorage() }
  }

  /** The storage a view keeps a file's values in, where it keeps any. */
  function kept(...args: Parameters<typeof agentStorage>): AgentStorage {
    const storage = agentStorage(...args)
    if (storage === undefined) throw new Error("The view keeps nothing here")
    return storage
  }

  it("keeps each file's values for the next view of it on its host, apart from other files' and the view's own", () => {
    const view = stableView()
    // The view's own keys, one of them named like a file's id.
    view.localStorage.setItem("ticks", "the view's own")
    view.localStorage.setItem(OTHER, '{"theme":"dark"}')

    kept(view, REPORT, HOST).save({ ticks: "[1,3]" })
    expect(kept(view, REPORT, HOST).load()).toEqual({ ticks: "[1,3]" })
    expect(kept(view, OTHER, HOST).load()).toEqual({})
    expect(view.localStorage.getItem("ticks")).toBe("the view's own")
  })

  it.each([
    ["its stable host, with the wildcard's port", `http://${HOST}`, HOST],
    ["its stable host named in capitals", `http://${HOST}`, HOST.toUpperCase()],
    ["a stable host whose wildcard names no port", `https://${DOMAIN}`, DOMAIN],
  ])("persists on %s", (_case, origin, expected) => {
    const view = { origin, localStorage: originStorage() }

    kept(view, REPORT, expected).save({ ticks: "[1]" })
    expect(kept(view, REPORT, expected).load()).toEqual({
      ticks: "[1]",
    })
  })

  it.each([
    ["another port", `http://${DOMAIN}:3918`, HOST],
    ["no port where one is expected", `http://${DOMAIN}`, HOST],
    ["a host below it", `http://view.${HOST}`, HOST],
    [
      "a host it is only the tail of",
      `http://${HOST}`,
      `mcp-apps.localhost:3917`,
    ],
    ["the shared sandbox", "http://sandbox.localhost:3917", HOST],
    ["an opaque origin", "null", HOST],
    ["a view the tools server named no host for", `http://${HOST}`, undefined],
  ])("keeps nothing on %s", (_case, origin, expected) => {
    const view = { origin, localStorage: originStorage() }

    expect(agentStorage(view, REPORT, expected)).toBeUndefined()
  })

  it.each([
    ["no fileId", undefined],
    ["a fileId one digit short", REPORT.slice(1)],
    ["a fileId in capitals", REPORT.toUpperCase()],
    ["a fileId that names a path", `../${REPORT}`],
  ])("keeps nothing for a result with %s", (_case, fileId) => {
    expect(agentStorage(stableView(), fileId, HOST)).toBeUndefined()
  })

  it("saves nothing past the file's share, and a full storage fails only that write, evicting nothing", () => {
    const view = stableView()
    const report = kept(view, REPORT, HOST, 32)
    const other = kept(view, OTHER, HOST, 32)
    report.save({ ticks: "[1]" })
    other.save({ theme: "dark" })

    report.save({ notes: "x".repeat(32) })
    expect(report.load()).toEqual({ ticks: "[1]" })
    view.localStorage.full = true
    expect(() => report.save({ ticks: "[1,3]" })).not.toThrow()
    expect(report.load()).toEqual({ ticks: "[1]" })
    expect(other.load()).toEqual({ theme: "dark" })
  })
})
