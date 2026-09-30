import { describe, expect, it, vi } from "vitest"

import {
  appMessageText,
  createRateLimiter,
  createResourceCache,
  downloadName,
  grantDisplayMode,
  offeredDisplayModes,
  openAppLink,
} from "./host-handlers"

describe("openAppLink", () => {
  it("opens an https link in a new unrelated context", () => {
    const open = vi.fn()
    expect(openAppLink("https://example.com/docs?q=1", { open })).toEqual({})
    expect(open).toHaveBeenCalledWith(
      "https://example.com/docs?q=1",
      "_blank",
      "noopener,noreferrer"
    )
  })

  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "file:///etc/passwd",
    "/relative",
    "not a url",
  ])("refuses %s", (url) => {
    const open = vi.fn()
    expect(openAppLink(url, { open })).toEqual({ isError: true })
    expect(open).not.toHaveBeenCalled()
  })
})

describe("downloadName", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\reports\\q3.pdf", "q3.pdf"],
    ["q3\u0000draft?.pdf", "q3_draft_.pdf"],
    [" .hidden ", "hidden"],
    ["", ""],
  ])("saves %j as %j", (name, saved) => {
    expect(downloadName(name)).toBe(saved)
  })
})

describe("createResourceCache", () => {
  it("shares a view resource's read per Agent, server, and URI", async () => {
    const cached = createResourceCache<void>()
    const reads: string[] = []
    const read = (
      label: string,
      agentId: string,
      toolName: string,
      uri: string
    ) =>
      cached({ agentId, toolName, uri }, async () => {
        reads.push(label)
      })
    await read("first", "researcher", "present_artifact", "ui://aos-ui/view")
    await read("same server", "researcher", "render_chart", "ui://aos-ui/view")
    await read("other Agent", "writer", "present_artifact", "ui://aos-ui/view")
    await read(
      "other server",
      "researcher",
      "mcp__maps__show",
      "ui://aos-ui/view"
    )
    await read(
      "data",
      "researcher",
      "present_artifact",
      "https://example.com/d"
    )
    await read(
      "data again",
      "researcher",
      "present_artifact",
      "https://example.com/d"
    )
    await read("unknown server", "researcher", "show_board", "ui://board/view")
    await read("unknown again", "researcher", "show_board", "ui://board/view")
    expect(reads).toEqual([
      "first",
      "other Agent",
      "other server",
      "data",
      "data again",
      "unknown server",
      "unknown again",
    ])
  })

  it("forgets a failed read and keeps only the latest reads", async () => {
    const cached = createResourceCache<string>(2)
    const request = (uri: string) => ({
      agentId: "researcher",
      toolName: "present_artifact",
      uri,
    })
    await expect(
      cached(request("ui://aos-ui/a"), async () => {
        throw new Error("offline")
      })
    ).rejects.toThrow("offline")
    expect(await cached(request("ui://aos-ui/a"), async () => "a")).toBe("a")
    await cached(request("ui://aos-ui/b"), async () => "b")
    await cached(request("ui://aos-ui/c"), async () => "c")
    expect(await cached(request("ui://aos-ui/a"), async () => "a again")).toBe(
      "a again"
    )
    expect(await cached(request("ui://aos-ui/c"), async () => "c again")).toBe(
      "c"
    )
  })
})

describe("appMessageText", () => {
  it("joins the text of a user message", () => {
    expect(
      appMessageText({
        role: "user",
        content: [
          { type: "text", text: "Summarize the board" },
          { type: "text", text: "Briefly" },
        ],
      })
    ).toBe("Summarize the board\n\nBriefly")
  })

  it.each([
    [
      "an assistant role",
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
    ["no content", { role: "user", content: [] }],
    ["blank text", { role: "user", content: [{ type: "text", text: "  " }] }],
    [
      "an image beside text",
      {
        role: "user",
        content: [{ type: "text", text: "hi" }, { type: "image" }],
      },
    ],
    [
      "a non-string text",
      { role: "user", content: [{ type: "text", text: 3 }] },
    ],
  ])("refuses %s", (_label, message) => {
    expect(appMessageText(message)).toBeUndefined()
  })
})

describe("createRateLimiter", () => {
  it("admits the limit per window and recovers when it slides", () => {
    let now = 0
    const admit = createRateLimiter(2, 1_000, () => now)
    expect([admit(), admit(), admit()]).toEqual([true, true, false])
    now = 999
    expect(admit()).toBe(false)
    now = 1_000
    expect(admit()).toBe(true)
  })
})

describe("grantDisplayMode", () => {
  it.each([
    ["fullscreen", "inline", false, "fullscreen"],
    ["inline", "fullscreen", false, "inline"],
    ["inline", "inline", false, "inline"],
    ["pip", "inline", false, "inline"],
    ["pip", "fullscreen", false, "fullscreen"],
    ["pip", "inline", true, "pip"],
    ["inline", "pip", true, "inline"],
    ["maximized", "pip", true, "pip"],
  ] as const)(
    "grants %s from %s (side panel %s) as %s",
    (requested, current, sidePanel, granted) => {
      expect(
        grantDisplayMode(requested, current, offeredDisplayModes(sidePanel))
      ).toBe(granted)
    }
  )
})

describe("grantDisplayMode with the view's declared modes", () => {
  it.each([
    [["inline"], "fullscreen", "inline", "inline"],
    [["inline", "fullscreen"], "fullscreen", "inline", "fullscreen"],
    [[], "fullscreen", "inline", "inline"],
    [["fullscreen"], "inline", "fullscreen", "fullscreen"],
    [["inline"], "pip", "inline", "inline"],
    [["inline", "pip"], "pip", "inline", "pip"],
  ] as const)(
    "with %j grants %s from %s as %s",
    (declared, requested, current, granted) => {
      expect(
        grantDisplayMode(
          requested,
          current,
          offeredDisplayModes(true),
          declared
        )
      ).toBe(granted)
    }
  )
})
