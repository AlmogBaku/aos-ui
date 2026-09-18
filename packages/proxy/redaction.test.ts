import { describe, expect, it } from "vitest"

import { redactForLog } from "./redaction"

describe("log redaction", () => {
  it("keeps a classification code while stripping a credential-bearing URL query", () => {
    expect(
      redactForLog({
        event: "hermes.run.failed",
        publicCode: "AOS_PROVIDER_RETRYABLE_FAILURE",
        code: "validation_exception",
        url: "https://example.test/oauth/callback?code=native-secret",
      })
    ).toEqual({
      event: "hermes.run.failed",
      publicCode: "AOS_PROVIDER_RETRYABLE_FAILURE",
      code: "validation_exception",
      url: "https://example.test/oauth/callback",
    })
  })

  it("still masks every credential-shaped key", () => {
    expect(
      redactForLog({
        authorization: "Bearer secret",
        cookie: "session=secret",
        "set-cookie": "session=secret",
        token: "secret",
        accessToken: "secret",
        refreshToken: "secret",
        secret: "secret",
        clientSecret: "secret",
        safe: "kept",
      })
    ).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "set-cookie": "[REDACTED]",
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      secret: "[REDACTED]",
      clientSecret: "[REDACTED]",
      safe: "kept",
    })
  })
})
