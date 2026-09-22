import { describe, expect, it } from "vitest"

import { stripAnsi } from "./strip-ansi"

describe("stripAnsi", () => {
  it("removes color, cursor, and hyperlink sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m plain")).toBe("red plain")
    expect(stripAnsi("\u001b[1;38;5;208mbold\u001b[m")).toBe("bold")
    expect(stripAnsi("line\u001b[2K\u001b[1Gnext")).toBe("linenext")
    expect(
      stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007")
    ).toBe("link")
    expect(stripAnsi("\u001b]0;title\u001b\\text")).toBe("text")
  })

  it("leaves plain text untouched", () => {
    expect(stripAnsi("a [1m] b\n  c")).toBe("a [1m] b\n  c")
  })
})
