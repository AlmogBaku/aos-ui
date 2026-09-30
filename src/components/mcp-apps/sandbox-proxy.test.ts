import { describe, expect, it } from "vitest"

import { injectHtmlCsp } from "./sandbox-proxy"

describe("injectHtmlCsp", () => {
  it("places the CSP as the real head's first child, before any scripts", () => {
    const secured = injectHtmlCsp(
      '<!-- <head>decoy</head> --><script>const value = "<head>"</script><p>Body</p>',
      "default-src 'none'"
    )
    const parsed = new DOMParser().parseFromString(secured, "text/html")
    const meta = parsed.head.querySelector<HTMLMetaElement>(
      'meta[http-equiv="Content-Security-Policy"]:first-child'
    )
    expect(meta).not.toBeNull()
    expect(meta?.content).toBe("default-src 'none'")
    expect(parsed.body.textContent).toContain("Body")
  })
})
