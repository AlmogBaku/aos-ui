import { describe, expect, it } from "vitest"

import { classifyArtifactPreview, parseCsvPreview } from "./artifact-renderers"
import {
  buildArtifactHtmlCsp,
  injectArtifactHtmlCsp,
} from "./artifact-frame-policy"

describe("classifyArtifactPreview", () => {
  it("maps supported MIME types to provider-neutral preview kinds", () => {
    expect([
      classifyArtifactPreview("text/markdown", "brief.md"),
      classifyArtifactPreview("text/plain; charset=utf-8", "notes.txt"),
      classifyArtifactPreview("application/typescript", "client.ts"),
      classifyArtifactPreview("application/json", "data.json"),
      classifyArtifactPreview("text/csv", "data.csv"),
      classifyArtifactPreview("image/png", "chart.png"),
      classifyArtifactPreview("application/pdf", "report.pdf"),
      classifyArtifactPreview("audio/mpeg", "brief.mp3"),
      classifyArtifactPreview("video/mp4", "demo.mp4"),
      classifyArtifactPreview("text/html", "preview.html"),
    ]).toEqual([
      "markdown",
      "text",
      "code",
      "json",
      "csv",
      "image",
      "pdf",
      "audio",
      "video",
      "html",
    ])
  })

  it("falls back to a known filename extension when MIME type is absent", () => {
    expect([
      classifyArtifactPreview(undefined, "README.md"),
      classifyArtifactPreview(undefined, "results.json"),
      classifyArtifactPreview(undefined, "table.csv"),
      classifyArtifactPreview(undefined, "component.tsx"),
      classifyArtifactPreview(undefined, "page.html"),
      classifyArtifactPreview(undefined, "archive.zip"),
    ]).toEqual(["markdown", "json", "csv", "code", "html", "unsupported"])
  })
})

describe("parseCsvPreview", () => {
  it("parses quoted commas, escaped quotes, and embedded newlines", () => {
    expect(
      parseCsvPreview(
        'name,notes\r\n"Ada, A.","First line\nSecond line"\r\nLin,"Said ""hello"""'
      )
    ).toEqual({
      rows: [
        ["name", "notes"],
        ["Ada, A.", "First line\nSecond line"],
        ["Lin", 'Said "hello"'],
      ],
      truncated: false,
    })
  })

  it("caps large previews at 500 rows", () => {
    const csv = Array.from({ length: 501 }, (_, index) => `row-${index}`).join(
      "\n"
    )

    const preview = parseCsvPreview(csv)

    expect(preview.rows).toHaveLength(500)
    expect(preview.rows.at(-1)).toEqual(["row-499"])
    expect(preview.truncated).toBe(true)
  })
})

describe("artifact HTML frame policy", () => {
  it("allows only normalized HTTPS asset origins", () => {
    expect(
      buildArtifactHtmlCsp([
        "https://cdn.example/assets/file.png",
        "http://insecure.example",
        "javascript:alert(1)",
        "https://media.example:8443/path",
      ])
    ).toBe(
      "default-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; script-src 'unsafe-inline' https://cdn.example https://media.example:8443; style-src 'unsafe-inline' https://cdn.example https://media.example:8443; img-src data: blob: https://cdn.example https://media.example:8443; media-src data: blob: https://cdn.example https://media.example:8443; font-src data: https://cdn.example https://media.example:8443; connect-src https://cdn.example https://media.example:8443; frame-src https://cdn.example https://media.example:8443"
    )
  })

  it("injects the policy into the document head before executable content", () => {
    const html =
      "<!doctype html><html><head><script>run()</script></head><body>Hi</body></html>"
    const secured = injectArtifactHtmlCsp(html, [])

    expect(secured.indexOf("Content-Security-Policy")).toBeGreaterThan(-1)
    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(
      secured.indexOf("<script>")
    )
    expect(secured).toContain("connect-src 'none'")
    expect(secured).toContain("frame-src 'none'")
  })

  it("places CSP in the real head despite decoy tags in comments and scripts", () => {
    const secured = injectArtifactHtmlCsp(
      '<!-- <head>decoy</head> --><script>const value = "<head>"</script><p>Body</p>',
      []
    )
    const parsed = new DOMParser().parseFromString(secured, "text/html")

    expect(
      parsed.head.querySelector(
        'meta[http-equiv="Content-Security-Policy"]:first-child'
      )
    ).not.toBeNull()
    expect(parsed.body.textContent).toContain("Body")
  })
})
