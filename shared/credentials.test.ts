import { describe, expect, it } from "vitest"

import { containsCredential, redactCredentials } from "./credentials"

describe("redactCredentials", () => {
  it("masks only the secret value, keeping its label and the text around it", () => {
    expect(
      redactCredentials(
        'curl -H "Authorization: Bearer abc123def" https://example.invalid'
      )
    ).toBe('curl -H "Authorization: Bearer [REDACTED]" https://example.invalid')
    expect(redactCredentials("login password=hunter2 then retry")).toBe(
      "login password=[REDACTED] then retry"
    )
  })

  it("masks a self-identifying token whole", () => {
    expect(redactCredentials("use sk-live-0123456789 here")).toBe(
      "use [REDACTED] here"
    )
  })

  it("leaves a value that only names a secret readable", () => {
    const command =
      'curl -H "Authorization: Bearer $SHORTENER_TOKEN" -d token=${TOKEN} -H "api_key: <key>"'
    expect(redactCredentials(command)).toBe(command)
    expect(containsCredential(command)).toBe(false)
  })
})
