// @vitest-environment jsdom

import { describe, expect, it } from "vitest"

import { injectHtmlCsp } from "./sandbox-proxy"

describe("injectHtmlCsp", () => {
  it("injects the policy into the document head before executable content", () => {
    const html =
      "<!doctype html><html><head><script>run()</script></head><body>Hi</body></html>"
    const secured = injectHtmlCsp(html, "default-src 'none'")

    expect(secured.indexOf("Content-Security-Policy")).toBeGreaterThan(-1)
    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(
      secured.indexOf("<script>")
    )
    expect(secured).toContain("default-src 'none'")
  })

  it("places CSP in the real head despite decoy tags in comments and scripts", () => {
    const secured = injectHtmlCsp(
      '<!-- <head>decoy</head> --><script>const value = "<head>"</script><p>Body</p>',
      "default-src 'none'"
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
