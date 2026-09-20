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

  it("masks the keys a push subscription and a VAPID pair carry", () => {
    expect(
      redactForLog({
        event: "push.delivery.failed",
        privateKey: "secret",
        applicationServerKey: "secret",
        endpoint: "https://push.example.test/subscription-id",
        keys: { p256dh: "secret", auth: "secret" },
        category: "input",
      })
    ).toEqual({
      event: "push.delivery.failed",
      privateKey: "[REDACTED]",
      applicationServerKey: "[REDACTED]",
      endpoint: "[REDACTED]",
      keys: { p256dh: "[REDACTED]", auth: "[REDACTED]" },
      category: "input",
    })
  })
})
