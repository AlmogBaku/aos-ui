import { describe, expect, it, vi } from "vitest"

import {
  appMessageText,
  createRateLimiter,
  grantDisplayMode,
  openAppLink,
} from "./host-handlers"

describe("openAppLink", () => {
  it("opens an https link in a new unrelated context", () => {
    const open = vi.fn()
    expect(openAppLink("https://example.com/docs?q=1", open)).toEqual({})
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
    expect(openAppLink(url, open)).toEqual({ isError: true })
    expect(open).not.toHaveBeenCalled()
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
    ["fullscreen", "inline", "fullscreen"],
    ["inline", "fullscreen", "inline"],
    ["inline", "inline", "inline"],
    ["pip", "inline", "inline"],
    ["pip", "fullscreen", "fullscreen"],
    ["maximized", "inline", "inline"],
  ] as const)("grants %s from %s as %s", (requested, current, granted) => {
    expect(grantDisplayMode(requested, current)).toBe(granted)
  })
})

describe("grantDisplayMode with the view's declared modes", () => {
  it.each([
    [["inline"], "fullscreen", "inline", "inline"],
    [["inline", "fullscreen"], "fullscreen", "inline", "fullscreen"],
    [[], "fullscreen", "inline", "inline"],
    [["fullscreen"], "inline", "fullscreen", "fullscreen"],
    [["inline", "pip"], "pip", "inline", "inline"],
  ] as const)(
    "with %j grants %s from %s as %s",
    (declared, requested, current, granted) => {
      expect(grantDisplayMode(requested, current, declared)).toBe(granted)
    }
  )
})
