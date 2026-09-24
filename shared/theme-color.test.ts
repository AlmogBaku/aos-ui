import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { oklchToHex, readTitleBarColors } from "./theme-color"

const globalsCss = readFileSync(
  path.resolve(import.meta.dirname, "../src/app/globals.css"),
  "utf8"
)

describe("title bar color", () => {
  // Pinned to pixels sampled from real Chromium renders of the workspace, so a
  // typo in the conversion cannot ship a title bar that misses the rail.
  it("converts the workspace surfaces to the sRGB the browser paints", () => {
    expect(oklchToHex(0.975, 0.003, 265)).toBe("#f6f7f9")
    expect(oklchToHex(0.23, 0.006, 265)).toBe("#1b1d20")
    expect(oklchToHex(0.99, 0.002, 265)).toBe("#fbfcfd")
  })

  it("reads both themes from the live stylesheet", () => {
    expect(readTitleBarColors(globalsCss)).toEqual({
      light: expect.stringMatching(/^#[0-9a-f]{6}$/),
      dark: expect.stringMatching(/^#[0-9a-f]{6}$/),
    })
  })

  it("fails loudly when the token is missing", () => {
    expect(() => readTitleBarColors(":root {\n}\n.dark {\n}\n")).toThrow(
      /--sidebar/
    )
    expect(() => readTitleBarColors("")).toThrow(/:root/)
  })
})
