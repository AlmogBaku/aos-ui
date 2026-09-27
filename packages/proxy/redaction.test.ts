import { describe, expect, it } from "vitest"

import { createProxyLogger } from "./cli/logger"
import { CredentialValues, redactForLog } from "./redaction"

describe("log redaction", () => {
  it("keeps a classification code while stripping the credentials of a URL of any scheme", () => {
    expect(
      redactForLog({
        event: "hermes.turn.failed",
        publicCode: "AOS_PROVIDER_RETRYABLE_FAILURE",
        code: "validation_exception",
        url: "https://example.test/oauth/callback?code=native-secret",
        detail:
          "dial wss://aos:tok-test-1@hermes.example.test/api/ws?token=tok-test-1#frame refused",
      })
    ).toEqual({
      event: "hermes.turn.failed",
      publicCode: "AOS_PROVIDER_RETRYABLE_FAILURE",
      code: "validation_exception",
      url: "https://example.test/oauth/callback",
      detail: "dial wss://hermes.example.test/api/ws refused",
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
        deviceToken: "secret",
        password: "secret",
        apiKey: "secret",
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
      deviceToken: "[REDACTED]",
      password: "[REDACTED]",
      apiKey: "[REDACTED]",
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

  it("logs an error by its redacted message, its classification, and its cause chain", () => {
    const refused = Object.assign(new Error("handshake refused"), {
      code: 4401,
      reason: "authentication_rejected",
    })
    const error = new Error(
      "dial wss://hermes.example.test/api/ws?token=tok-test-1 failed",
      { cause: refused }
    )

    expect(
      redactForLog({ event: "hermes.gateway.dial_failed", error })
    ).toEqual({
      event: "hermes.gateway.dial_failed",
      error: {
        name: "Error",
        message: "dial wss://hermes.example.test/api/ws failed",
        cause: {
          name: "Error",
          message: "handshake refused",
          code: 4401,
          reason: "authentication_rejected",
        },
      },
    })
  })

  it("writes no credential value the proxy has read or a child binds, its rotated successor and Basic form included", async () => {
    const credentials = new CredentialValues()
    const basic = (password: string) =>
      Buffer.from(`aos:${password}`).toString("base64")
    let stored = "tok-test-1"
    const readPassword = credentials.register(
      async () => stored,
      (password) => [password, basic(password)]
    )
    await readPassword()
    stored = "tok-test-2"
    await readPassword()
    const lines: string[] = []
    const logger = createProxyLogger({
      level: "info",
      credentials,
      destination: { write: (line) => void lines.push(line) },
    })

    logger.child({ peer: "tok-test-1", password: "synthetic-value" }).error(
      {
        event: "opencode.request.failed",
        error: new Error(`Basic ${basic("tok-test-2")} refused`),
      },
      "tok-test-2 rejected at wss://opencode.example.test/ws?token=abc"
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("synthetic-value")
    expect(JSON.parse(lines[0]!)).toMatchObject({
      peer: "[REDACTED]",
      password: "[REDACTED]",
      event: "opencode.request.failed",
      error: { name: "Error", message: "Basic [REDACTED] refused" },
      msg: "[REDACTED] rejected at wss://opencode.example.test/ws",
    })
  })
})
