import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  parseGuestComposerSlashCommandsEnabled,
  parseProxyConfig,
} from "./config"
import { redactForLog } from "./redaction"
import { readSecretFile, readSecretKeyFile } from "./secrets"

const temporaryDirectories: string[] = []

it.each([
  [undefined, false],
  ["", false],
  ["false", false],
  ["1", false],
  ["yes", false],
  ["true", true],
  [" TRUE ", true],
  ["\tTrUe\n", true],
] as const)("parses guest slash-command visibility %j as %s", (value, expected) => {
  expect(parseGuestComposerSlashCommandsEnabled(value)).toBe(expected)
})

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
    publicOrigin: "https://aos.example.test",
    operator: {
      issuer: "https://identity.example.test",
      clientId: "aos-ui",
      clientSecretFile: "/run/secrets/oidc-client-secret",
      principalHmacKeyFile: "/run/secrets/operator-principal-hmac",
      redirectUri: "https://aos.example.test/api/aos/v1/auth/operator/callback",
      allowedSubjects: ["operator@example.test"],
      session: {
        deploymentId: "production-a",
        keys: [
          { id: "current", secretFile: "/run/secrets/operator-session-key" },
        ],
        ttlSeconds: 900,
      },
    },
    hermes: {
      baseUrl: "http://127.0.0.1:9119",
      auth: { mode: "static-token", tokenFile },
    },
    events: {
      activeKeyId: "current",
      keys: [
        { id: "current", secretFile: "/run/secrets/reconnect-cursor-key" },
      ],
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

  it("requires exact public-origin OIDC and runtime-broker callbacks", () => {
    const browserBroker = {
      mode: "browser-broker" as const,
      callbackUrl:
        "https://aos.example.test/api/aos/v1/auth/runtime/upstream/auth/callback",
      allowedIdentityOrigins: ["https://identity.example.test"],
    }
    expect(
      parseProxyConfig({
        ...validConfig(),
        hermes: {
          baseUrl: "http://127.0.0.1:9119",
          auth: browserBroker,
        },
      }).hermes.auth
    ).toEqual(browserBroker)

    for (const candidate of [
      {
        ...validConfig(),
        operator: {
          ...validConfig().operator,
          redirectUri:
            "https://other.example.test/api/aos/v1/auth/operator/callback",
        },
      },
      {
        ...validConfig(),
        hermes: {
          baseUrl: "http://127.0.0.1:9119",
          auth: {
            ...browserBroker,
            callbackUrl: "https://aos.example.test/auth/callback",
          },
        },
      },
    ]) {
      expect(() => parseProxyConfig(candidate)).toThrow(
        "Invalid proxy configuration"
      )
    }
  })

  it("allows plain HTTP only for exact loopback application origins", () => {
    const loopback = {
      ...validConfig(),
      publicOrigin: "http://127.0.0.1:3000",
      operator: {
        ...validConfig().operator,
        redirectUri: "http://127.0.0.1:3000/api/aos/v1/auth/operator/callback",
      },
    }
    expect(parseProxyConfig(loopback).publicOrigin).toBe(
      "http://127.0.0.1:3000"
    )

    for (const publicOrigin of [
      "http://192.168.1.4:3000",
      "https://user@aos.example.test",
      "https://aos.example.test/path",
      "https://aos.example.test?debug=true",
      "https://aos.example.test#fragment",
    ]) {
      expect(() =>
        parseProxyConfig({ ...validConfig(), publicOrigin })
      ).toThrow("Invalid proxy configuration")
    }
  })

  it("requires the active reconnect key to be declared", () => {
    expect(() =>
      parseProxyConfig({
        ...validConfig(),
        events: { ...validConfig().events, activeKeyId: "missing" },
      })
    ).toThrow("Invalid proxy configuration")
  })

  it("accepts an explicitly private container listener without permitting an unscoped wildcard", () => {
    const containerConfig = {
      ...validConfig(),
      listen: {
        host: "0.0.0.0",
        port: 4100,
        exposure: "private-container",
      },
    }

    expect(parseProxyConfig(containerConfig)).toEqual(containerConfig)
    expect(() =>
      parseProxyConfig({
        ...containerConfig,
        listen: { host: "0.0.0.0", port: 4100 },
      })
    ).toThrow("Invalid proxy configuration")
  })

  it("accepts a separately addressed Hermes guest lane with file-backed invitation and runtime keys", () => {
    const configured = parseProxyConfig({
      ...validConfig(),
      guest: {
        listen: { host: "127.0.0.1", port: 4101 },
        publicOrigin: "https://guest.example.test",
        hermes: {
          baseUrl: "http://127.0.0.1:9120",
          tokenFile: "/run/secrets/hermes-guest-token",
        },
        invitations: {
          keys: [{ id: "guest-current", secretFile: "/run/secrets/guest-key" }],
          ttlSeconds: 300,
          clockSkewSeconds: 0,
        },
      },
    })

    expect(configured.guest).toMatchObject({
      listen: { host: "127.0.0.1", port: 4101 },
      publicOrigin: "https://guest.example.test",
      invitations: { ttlSeconds: 300, clockSkewSeconds: 0 },
    })
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

  it("decodes only canonical 32-byte base64url key files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aos-secret-key-"))
    temporaryDirectories.push(directory)
    const valid = join(directory, "valid")
    const invalid = join(directory, "invalid")
    await writeFile(valid, `${Buffer.alloc(32, 7).toString("base64url")}\n`, {
      mode: 0o600,
    })
    await writeFile(invalid, Buffer.alloc(31, 7).toString("base64url"), {
      mode: 0o600,
    })

    await expect(readSecretKeyFile(valid)).resolves.toEqual(
      new Uint8Array(Buffer.alloc(32, 7))
    )
    await expect(readSecretKeyFile(invalid)).rejects.toThrow(
      "Invalid secret key file"
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
