import { NextRequest } from "next/server"
import { describe, expect, it } from "vitest"

import { proxy } from "./proxy"

describe("locale proxy", () => {
  it("keeps workspace paths stable and seeds the negotiated locale cookie", () => {
    const response = proxy(
      new NextRequest("https://aos-ui.test/agent/session?view=active", {
        headers: { "accept-language": "he-IL, en;q=0.8" },
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("x-middleware-request-x-aos-ui-locale")).toBe(
      "he"
    )
    expect(response.cookies.get("aos-ui-locale")?.value).toBe("he")
  })

  it("uses the locale cookie before the browser language", () => {
    const response = proxy(
      new NextRequest("https://aos-ui.test/agent", {
        headers: {
          cookie: "aos-ui-locale=en",
          "accept-language": "he-IL",
        },
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-request-x-aos-ui-locale")).toBe(
      "en"
    )
  })

  it("redirects legacy locale paths without losing query parameters", () => {
    const response = proxy(
      new NextRequest("https://aos-ui.test/he/agent/session?view=active")
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe(
      "https://aos-ui.test/agent/session?view=active"
    )
    expect(response.cookies.get("aos-ui-locale")?.value).toBe("he")
  })
})
