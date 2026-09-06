import { describe, expect, it } from "vitest"

import { sanitizeMermaidSvg } from "./mermaid-sanitize"

describe("sanitizeMermaidSvg", () => {
  it("preserves a static Mermaid SVG and marks it decorative", () => {
    const result = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">
        <style>.edge { marker-end: url(#arrow); }</style>
        <defs><marker id="arrow"><path d="M0 0L5 2L0 4Z" /></marker></defs>
        <path class="edge" d="M0 0L10 10" />
        <text>Hello</text>
      </svg>
    `)

    const document = new DOMParser().parseFromString(result, "image/svg+xml")
    const svg = document.documentElement
    expect(svg.localName).toBe("svg")
    expect(svg.getAttribute("aria-hidden")).toBe("true")
    expect(svg.getAttribute("focusable")).toBe("false")
    expect(svg.querySelector("text")?.textContent).toBe("Hello")
    expect(svg.querySelector("style")?.textContent).toContain("url(#arrow)")
  })

  it("removes active and externally loaded SVG content", () => {
    const result = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
        xml:base="https://bad.example/" onload="steal()"
        style="background:url(https://bad.example/bg.png)">
        <script>steal()</script>
        <foreignObject><iframe src="https://bad.example/frame" /></foreignObject>
        <image href="https://bad.example/image.png" />
        <feImage xlink:href="https://bad.example/filter.png" />
        <animate attributeName="href" to="javascript:steal()" />
        <a href="https://bad.example/link" target="_blank"><text>Label</text></a>
        <use href="https://bad.example/icons.svg#icon" />
        <path onclick="steal()" fill="url(https://bad.example/paint.svg#x)" />
        <style>@import url("https://bad.example/theme.css"); .x{fill:red}</style>
        <style>.escaped{background:u\\72l(https://bad.example/escaped)}</style>
        <style>.set{background:image-set("relative.png" 1x)}</style>
      </svg>
    `)

    expect(result).not.toMatch(
      /bad\.example|javascript:|<script|foreignObject|<iframe|<image|<feImage|<animate|\sonload=|\sonclick=|\starget=/i
    )

    const document = new DOMParser().parseFromString(result, "image/svg+xml")
    expect(document.querySelector("a text")?.textContent).toBe("Label")
    expect(document.querySelector("a")?.hasAttribute("href")).toBe(false)
    expect(document.querySelector("use")?.hasAttribute("href")).toBe(false)
  })

  it("allows fragment-only references needed by Mermaid markers", () => {
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="#node"/><path marker-end="url(#arrow)"/></svg>'
    )

    const document = new DOMParser().parseFromString(result, "image/svg+xml")
    expect(document.querySelector("use")?.getAttribute("href")).toBe("#node")
    expect(document.querySelector("path")?.getAttribute("marker-end")).toBe(
      "url(#arrow)"
    )
  })

  it("rejects malformed output and non-SVG roots", () => {
    expect(() => sanitizeMermaidSvg("<svg><g></svg>")).toThrow(/valid SVG/i)
    expect(() => sanitizeMermaidSvg("<div>not a diagram</div>")).toThrow(
      /valid SVG/i
    )
  })
})
