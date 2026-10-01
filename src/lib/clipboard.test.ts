import { afterEach, describe, expect, it, vi } from "vitest"

import { copyMarkdownToClipboard } from "./clipboard"

describe("copyMarkdownToClipboard", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("writes the markdown source as plain text beside its rendered HTML", async () => {
    const written: Record<string, Blob>[] = []
    const writeText = vi.fn()
    vi.stubGlobal("window", { isSecureContext: true })
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly items: Record<string, Blob>) {}
      }
    )
    vi.stubGlobal("navigator", {
      clipboard: {
        write: async (items: { items: Record<string, Blob> }[]) => {
          written.push(...items.map((item) => item.items))
        },
        writeText,
      },
    })

    await copyMarkdownToClipboard("ok: **false**\n\n- sous-chef")

    expect(writeText).not.toHaveBeenCalled()
    expect(written).toHaveLength(1)
    const [item] = written
    expect(Object.keys(item!)).toEqual(["text/plain", "text/html"])
    expect(await item!["text/plain"]!.text()).toBe(
      "ok: **false**\n\n- sous-chef"
    )
    expect(await item!["text/html"]!.text()).toBe(
      "<p>ok: <strong>false</strong></p>\n<ul>\n<li>sous-chef</li>\n</ul>"
    )
  })
})
