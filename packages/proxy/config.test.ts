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
    version: 1 as const,
    deploymentId: "production-a",
    listen: { host: "127.0.0.1" as const, port: 4100 },
    publicOrigin: "https://aos.example.test",
    runtime: {
      id: "hermes-main",
      kind: "hermes" as const,
      baseUrl: "http://127.0.0.1:9119",
      tokenFile,
      sessionIdleMs: 300_000,
    },
    events: {
      activeKeyId: "current",
      keys: [
        { id: "current", secretFile: "/run/secrets/reconnect-cursor-key" },
      ],
    },
    limits: {
      activeExecutions: 256,
      guestActiveExecutions: 32,
      operatorEventPeers: 256,
      subscriberEvents: 512,
      subscriberBytes: 2_097_152,
    },
    shutdownGraceMs: 5_000,
  }
}

describe("proxy configuration and secret boundary", () => {
  it("accepts the minimal server-token-only V1 configuration", () => {
    expect(parseProxyConfig(validConfig())).toEqual(validConfig())
  })

  it("accepts the exact private OpenCode runtime configuration", () => {
    const input = {
      ...validConfig(),
      runtime: {
        id: "opencode-main",
        kind: "opencode" as const,
        baseUrl: "http://127.0.0.1:4096/",
        directory: "/workspace",
        username: "opencode",
        passwordFile: "/run/secrets/opencode-password",
      },
    }

    expect(parseProxyConfig(input).runtime).toEqual({
      ...input.runtime,
      baseUrl: "http://127.0.0.1:4096",
    })
  })

  it("accepts the exact private OpenClaw runtime configuration", () => {
    const input = {
      ...validConfig(),
      runtime: {
        id: "openclaw-main",
        kind: "openclaw" as const,
        baseUrl: "wss://gateway.example.test/",
        deviceIdentityFile: "/run/secrets/openclaw-device",
        deviceTokenFile: "/run/secrets/openclaw-token",
      },
    }

    expect(parseProxyConfig(input).runtime).toEqual({
      ...input.runtime,
      baseUrl: "wss://gateway.example.test",
    })
  })

  it("rejects unsafe OpenCode and OpenClaw runtime configuration", () => {
    for (const runtime of [
      {
        id: "opencode-main",
        kind: "opencode",
        baseUrl: "http://secret@example.test",
        directory: "relative",
        username: "operator:admin",
        passwordFile: "password",
      },
      {
        id: "openclaw-main",
        kind: "openclaw",
        baseUrl: "https://gateway.example.test",
        deviceIdentityFile: "device.json",
        deviceTokenFile: "/run/secrets/openclaw-token",
      },
      {
        id: "openclaw-main",
        kind: "openclaw",
        baseUrl: "wss://token@gateway.example.test",
        deviceIdentityFile: "/run/secrets/openclaw-device",
        deviceTokenFile: "/run/secrets/openclaw-token",
      },
    ])
      expect(() => parseProxyConfig({ ...validConfig(), runtime })).toThrow(
        "Invalid proxy configuration"
      )
  })

  it("rejects legacy operator, OIDC, and Hermes browser-broker fields", () => {
    for (const legacy of [
      { operator: { issuer: "https://identity.example.test" } },
      { hermes: { auth: { mode: "browser-broker" } } },
      { runtimeAuth: { callbackUrl: "https://aos.example.test/callback" } },
    ])
      expect(() => parseProxyConfig({ ...validConfig(), ...legacy })).toThrow(
        "Invalid proxy configuration"
      )
  })

  it("rejects wildcard listeners, inline secrets, and unknown fields", () => {
    for (const candidate of [
      { ...validConfig(), listen: { host: "0.0.0.0", port: 4100 } },
      {
        ...validConfig(),
        runtime: { ...validConfig().runtime, token: "secret" },
      },
      { ...validConfig(), extra: true },
    ])
      expect(() => parseProxyConfig(candidate)).toThrow(
        "Invalid proxy configuration"
      )
  })

  it("accepts a guest lane without a second runtime or token", () => {
    const configured = parseProxyConfig({
      ...validConfig(),
      guest: {
        listen: { host: "127.0.0.1", port: 4101 },
        publicOrigin: "https://guest.example.test",
        invitations: {
          keys: [{ id: "guest", secretFile: "/run/secrets/guest-key" }],
          ttlSeconds: 300,
          clockSkewSeconds: 0,
        },
      },
    })
    expect(configured.guest).toEqual({
      listen: { host: "127.0.0.1", port: 4101 },
      publicOrigin: "https://guest.example.test",
      invitations: {
        keys: [{ id: "guest", secretFile: "/run/secrets/guest-key" }],
        ttlSeconds: 300,
        clockSkewSeconds: 0,
      },
    })
  })

  it("requires distinct operator and guest origins and listeners", () => {
    for (const guest of [
      {
        listen: { host: "127.0.0.1", port: 4101 },
        publicOrigin: "https://aos.example.test",
      },
      {
        listen: { host: "127.0.0.1", port: 4100 },
        publicOrigin: "https://guest.example.test",
      },
    ])
      expect(() =>
        parseProxyConfig({
          ...validConfig(),
          guest: {
            ...guest,
            invitations: {
              keys: [{ id: "guest", secretFile: "/run/secrets/guest-key" }],
              ttlSeconds: 300,
              clockSkewSeconds: 0,
            },
          },
        })
      ).toThrow("Invalid proxy configuration")
  })

  it("accepts plain HTTP only for exact loopback application origins", () => {
    expect(
      parseProxyConfig({
        ...validConfig(),
        publicOrigin: "http://127.0.0.1:3000",
      }).publicOrigin
    ).toBe("http://127.0.0.1:3000")
    expect(() =>
      parseProxyConfig({
        ...validConfig(),
        publicOrigin: "http://192.168.1.4:3000",
      })
    ).toThrow("Invalid proxy configuration")
  })

  it("requires active reconnect keys and coherent limits", () => {
    for (const candidate of [
      {
        ...validConfig(),
        events: { ...validConfig().events, activeKeyId: "missing" },
      },
      {
        ...validConfig(),
        limits: { ...validConfig().limits, guestActiveExecutions: 257 },
      },
    ])
      expect(() => parseProxyConfig(candidate)).toThrow(
        "Invalid proxy configuration"
      )
  })

  it("reads a bounded owner-only secret and trims its trailing newline", async () => {
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

  it("redacts credentials and URL query values", () => {
    expect(
      redactForLog({
        authorization: "Bearer secret",
        nested: { token: "secret", safe: "kept" },
        url: "https://example.test/path?code=secret",
      })
    ).toEqual({
      authorization: "[REDACTED]",
      nested: { token: "[REDACTED]", safe: "kept" },
      url: "https://example.test/path",
    })
  })
})
