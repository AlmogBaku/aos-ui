import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { parseProxyConfig } from "./config"
import { redactForLog } from "./redaction"
import { readSecretFile } from "./secrets"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

function validConfig(tokenFile = "/run/secrets/hermes-token") {
  return {
    version: 1,
    listen: { host: "127.0.0.1", port: 4100 },
    publicOrigin: "http://127.0.0.1:3000",
    operator: {
      issuer: "https://identity.example.test",
      clientId: "aos-ui",
      clientSecretFile: "/run/secrets/oidc-client-secret",
      redirectUri: "http://127.0.0.1:4100/api/aos/v1/auth/operator/callback",
      allowedSubjects: ["operator@example.test"],
    },
    hermes: {
      baseUrl: "http://127.0.0.1:9119",
      auth: { mode: "static-token", tokenFile },
    },
    shutdownGraceMs: 5_000,
  }
}

describe("proxy configuration and secret boundary", () => {
  it("accepts a loopback listener with OIDC allowlist and secret references", () => {
    expect(parseProxyConfig(validConfig())).toEqual(validConfig())
  })

  it("rejects wildcard listeners, inline secrets, and unknown keys", () => {
    for (const candidate of [
      { ...validConfig(), listen: { host: "0.0.0.0", port: 4100 } },
      {
        ...validConfig(),
        hermes: { baseUrl: "http://127.0.0.1:9119", token: "secret" },
      },
      { ...validConfig(), extra: true },
    ]) {
      expect(() => parseProxyConfig(candidate)).toThrow(
        "Invalid proxy configuration"
      )
    }
  })

  it("reads a bounded owner-only secret and trims its single trailing newline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aos-secret-"))
    temporaryDirectories.push(directory)
    const file = join(directory, "token")
    await writeFile(file, "hermes-token\n", { mode: 0o600 })
    expect(await readSecretFile(file)).toBe("hermes-token")
  })

  it("rejects a secret file readable by group or other users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aos-secret-"))
    temporaryDirectories.push(directory)
    const file = join(directory, "token")
    await writeFile(file, "hermes-token", { mode: 0o600 })
    await chmod(file, 0o644)
    await expect(readSecretFile(file)).rejects.toThrow(
      "Secret file permissions are too broad"
    )
  })

  it("redacts nested credentials and URL query values without serializing errors", () => {
    expect(
      redactForLog({
        authorization: "Bearer secret",
        nested: { token: "secret", safe: "kept" },
        url: "https://example.test/path?code=secret",
        error: new Error("native failure at /private/path token=secret"),
      })
    ).toEqual({
      authorization: "[REDACTED]",
      nested: { token: "[REDACTED]", safe: "kept" },
      url: "https://example.test/path",
      error: { name: "Error", message: "Upstream request failed" },
    })
  })
})
