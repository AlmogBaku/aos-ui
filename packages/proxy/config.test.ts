import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { isHttpsOrLoopback, parseProxyConfig } from "./config"
import { redactForLog } from "./redaction"
import { readSecretFile, readSecretKeyFile } from "./secrets"

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

/** The push block the deployment examples ship, paths only. */
function validPush() {
  return {
    stateDir: "/var/lib/aos-ui/push",
    vapid: {
      subject: "mailto:ops@example.com",
      privateKeyFile: "/run/secrets/vapid-private-key",
    },
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
    expect(
      parseProxyConfig({
        ...validConfig(),
        publicOrigin: "http://localhost:3000",
      }).publicOrigin
    ).toBe("http://localhost:3000")
    expect(() =>
      parseProxyConfig({
        ...validConfig(),
        publicOrigin: "http://192.168.1.4:3000",
      })
    ).toThrow("Invalid proxy configuration")
  })

  it("accepts an optional push deployment, and a deployment without one", () => {
    expect(
      parseProxyConfig({ ...validConfig(), push: validPush() }).push
    ).toEqual(validPush())
    expect(parseProxyConfig(validConfig()).push).toBeUndefined()
  })

  it("rejects push state outside an absolute path, an insecure subject, and configured key material", () => {
    for (const push of [
      { ...validPush(), stateDir: "var/lib/aos-ui/push" },
      {
        ...validPush(),
        vapid: { ...validPush().vapid, subject: "http://ops.example.test" },
      },
      {
        ...validPush(),
        vapid: { ...validPush().vapid, privateKeyFile: "vapid-private-key" },
      },
      {
        ...validPush(),
        vapid: { ...validPush().vapid, publicKey: "A".repeat(87) },
      },
      { ...validPush(), publicKey: "A".repeat(87) },
      { ...validPush(), extra: true },
    ])
      expect(() => parseProxyConfig({ ...validConfig(), push })).toThrow(
        "Invalid proxy configuration"
      )
  })

  it("requires coherent execution limits", () => {
    expect(() =>
      parseProxyConfig({
        ...validConfig(),
        limits: { ...validConfig().limits, guestActiveExecutions: 257 },
      })
    ).toThrow("Invalid proxy configuration")
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

describe("voice configuration", () => {
  function validTranscription() {
    return {
      provider: "openai-compatible" as const,
      baseUrl: "https://stt.example.test/v1",
      apiKeyFile: "/run/secrets/voice-stt-key",
      model: "whisper-1",
    }
  }

  function validSpeech() {
    return {
      provider: "openai-compatible" as const,
      baseUrl: "https://tts.example.test/v1",
      apiKeyFile: "/run/secrets/voice-tts-key",
      model: "tts-1",
      voice: "alloy",
    }
  }

  it("accepts a full voice block and applies defaults for mode, format, and timeoutMs", () => {
    const input = {
      ...validConfig(),
      voice: {
        transcription: validTranscription(),
        speech: { ...validSpeech(), mode: "override" as const },
      },
    }
    const parsed = parseProxyConfig(input)
    expect(parsed.voice?.transcription).toMatchObject({
      ...validTranscription(),
      mode: "fallback",
      timeoutMs: 60_000,
    })
    expect(parsed.voice?.speech).toMatchObject({
      ...validSpeech(),
      mode: "override",
      format: "mp3",
      timeoutMs: 60_000,
    })
  })

  it("accepts a voice block with only transcription", () => {
    const parsed = parseProxyConfig({
      ...validConfig(),
      voice: { transcription: validTranscription() },
    })
    expect(parsed.voice?.transcription?.model).toBe("whisper-1")
    expect(parsed.voice?.speech).toBeUndefined()
  })

  it("accepts a voice block with only speech", () => {
    const parsed = parseProxyConfig({
      ...validConfig(),
      voice: { speech: validSpeech() },
    })
    expect(parsed.voice?.speech?.model).toBe("tts-1")
    expect(parsed.voice?.transcription).toBeUndefined()
  })

  it.each([
    ["an empty voice block", {}],
    [
      "an unknown provider",
      { transcription: { ...validTranscription(), provider: "azure" } },
    ],
    [
      "an unknown key inside a voice child",
      { transcription: { ...validTranscription(), extra: true } },
    ],
    [
      "a relative apiKeyFile",
      {
        transcription: { ...validTranscription(), apiKeyFile: "relative/path" },
      },
    ],
    [
      "speech without the speaker voice field",
      {
        speech: {
          provider: "openai-compatible",
          baseUrl: "https://tts.example.test/v1",
          model: "tts-1",
        },
      },
    ],
    [
      "timeoutMs below minimum",
      { transcription: { ...validTranscription(), timeoutMs: 500 } },
    ],
  ])("rejects %s", (_case, voice) => {
    expect(() => parseProxyConfig({ ...validConfig(), voice })).toThrow(
      "Invalid proxy configuration"
    )
  })

  it("validates language: rejects 'english', accepts 'he' and 'en-US'", () => {
    expect(() =>
      parseProxyConfig({
        ...validConfig(),
        voice: {
          transcription: { ...validTranscription(), language: "english" },
        },
      })
    ).toThrow("Invalid proxy configuration")
    for (const language of ["he", "en-US"]) {
      expect(
        parseProxyConfig({
          ...validConfig(),
          voice: {
            transcription: { ...validTranscription(), language },
          },
        }).voice?.transcription?.language
      ).toBe(language)
    }
  })

  it("enforces HTTPS or loopback when apiKeyFile is set", () => {
    // http non-loopback with key → rejected
    expect(() =>
      parseProxyConfig({
        ...validConfig(),
        voice: {
          transcription: {
            ...validTranscription(),
            baseUrl: "http://stt.example.test/v1",
          },
        },
      })
    ).toThrow("Invalid proxy configuration")

    // http loopback with key → accepted
    for (const baseUrl of [
      "http://127.0.0.1:8000/v1",
      "http://localhost:8000/v1",
    ]) {
      expect(
        parseProxyConfig({
          ...validConfig(),
          voice: { transcription: { ...validTranscription(), baseUrl } },
        }).voice?.transcription?.model
      ).toBe("whisper-1")
    }

    // http non-loopback without key → accepted
    expect(
      parseProxyConfig({
        ...validConfig(),
        voice: {
          transcription: {
            provider: "openai-compatible" as const,
            baseUrl: "http://stt.example.test/v1",
            model: "whisper-1",
          },
        },
      }).voice?.transcription?.model
    ).toBe("whisper-1")

    // https non-loopback with key → accepted
    expect(
      parseProxyConfig({
        ...validConfig(),
        voice: {
          transcription: {
            ...validTranscription(),
            baseUrl: "https://stt.example.test/v1",
          },
        },
      }).voice?.transcription?.model
    ).toBe("whisper-1")
  })
})

describe("isHttpsOrLoopback", () => {
  it("accepts HTTPS and loopback HTTP URLs", () => {
    expect(isHttpsOrLoopback(new URL("https://example.test"))).toBe(true)
    expect(isHttpsOrLoopback(new URL("http://127.0.0.1:3000"))).toBe(true)
    expect(isHttpsOrLoopback(new URL("http://localhost:3000"))).toBe(true)
    expect(isHttpsOrLoopback(new URL("http://[::1]:3000"))).toBe(true)
  })

  it("rejects non-loopback HTTP URLs", () => {
    expect(isHttpsOrLoopback(new URL("http://example.test"))).toBe(false)
    expect(isHttpsOrLoopback(new URL("http://192.168.1.4:3000"))).toBe(false)
  })
})

describe("MCP Apps fallback credentials", () => {
  const withHeaders = (headers: Record<string, unknown>) => ({
    ...validConfig(),
    mcpApps: { fallback: { servers: { weather: { headers } } } },
  })

  it("accepts a header whose value lives in an absolute file", () => {
    const parsed = parseProxyConfig(
      withHeaders({ Authorization: { file: "/run/secrets/weather-mcp" } })
    )
    expect(parsed.mcpApps?.fallback.servers.weather?.headers).toEqual({
      Authorization: { file: "/run/secrets/weather-mcp" },
    })
  })

  it("rejects a relative file, an inline value, and a header name that is not a token", () => {
    for (const headers of [
      { Authorization: { file: "secrets/weather-mcp" } },
      { Authorization: "Bearer inline" },
      { "Bad Header": { file: "/run/secrets/weather-mcp" } },
    ])
      expect(() => parseProxyConfig(withHeaders(headers))).toThrow(
        "Invalid proxy configuration"
      )
  })
  const withServer = (server: Record<string, unknown>) => ({
    ...validConfig(),
    mcpApps: { fallback: { servers: { "aos-ui": server } } },
  })
  const header = { Authorization: { file: "/run/secrets/aos-ui-mcp" } }

  it("accepts a URL override alone, including a plain-HTTP Compose service", () => {
    const parsed = parseProxyConfig(
      withServer({ url: "http://tools-mcp:4110/mcp" })
    )
    expect(parsed.mcpApps?.fallback.servers["aos-ui"]).toEqual({
      url: "http://tools-mcp:4110/mcp",
    })
  })

  it("accepts a URL override with headers over HTTPS or loopback", () => {
    for (const url of [
      "https://tools.example.test/mcp",
      "http://127.0.0.1:4110/mcp",
    ])
      expect(
        parseProxyConfig(withServer({ url, headers: header })).mcpApps?.fallback
          .servers["aos-ui"]
      ).toEqual({ url, headers: header })
  })

  it("rejects a non-HTTP URL, headers over non-loopback HTTP, and an empty entry", () => {
    for (const server of [
      { url: "ws://tools-mcp:4110/mcp" },
      { url: "file:///run/mcp" },
      { url: "http://tools-mcp:4110/mcp", headers: header },
      {},
    ])
      expect(() => parseProxyConfig(withServer(server))).toThrow(
        "Invalid proxy configuration"
      )
  })
})
