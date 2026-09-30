// @vitest-environment node

import { describe, expect, it } from "vitest"

import { buildPdfjs, buildViews } from "./build"

/** The proxy refuses an App document, or any resource it reads, above this size. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

describe("buildViews", () => {
  it("builds every view into one self-contained document", async () => {
    const views = await buildViews()

    expect(Object.keys(views).sort()).toEqual([
      "artifact",
      "chart",
      "map",
      "stats",
    ])
    for (const [name, html] of Object.entries(views)) {
      expect(new TextEncoder().encode(html).length, name).toBeLessThan(
        MAX_DOCUMENT_BYTES
      )
      // The inlined code never closes its own element, so the document holds
      // exactly one script and one stylesheet, with nothing to fetch.
      expect(html.match(/<\/script/giu), name).toHaveLength(1)
      expect(html.match(/<\/style/giu), name).toHaveLength(1)
      expect(html, name).toMatch(/<script type="module">/u)
      expect(html, name).not.toMatch(/<link\b/iu)
      expect(html, name).toMatch(/<div id="root"><\/div>/u)
    }
  }, 120_000)
})

describe("buildPdfjs", () => {
  it("copies what the worker asks for, each file under the resource limit", async () => {
    const files = await buildPdfjs()

    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        "pdf.worker.js",
        "cmaps/UniGB-UCS2-H.bcmap",
        "standard_fonts/LiberationSans-Regular.ttf",
        "wasm/jbig2.wasm",
        "wasm/openjpeg.wasm",
      ])
    )
    expect(files.has("wasm/quickjs-eval.wasm")).toBe(false)
    // A binary file travels as base64, the larger of the two encodings.
    for (const [name, bytes] of files)
      expect(Math.ceil(bytes.length / 3) * 4, name).toBeLessThan(
        MAX_DOCUMENT_BYTES
      )
  }, 120_000)
})
