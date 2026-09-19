import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createHermesRuntime } from "./adapters/hermes/factory"
import { runProxyCli } from "./cli"
import type { startProxyServer } from "./server"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function proxyConfig() {
  const directory = await mkdtemp(join(tmpdir(), "aos-proxy-cli-"))
  temporaryDirectories.push(directory)
  const key = Buffer.alloc(32, 7).toString("base64url")
  const writeSecret = async (name: string, value: string) => {
    const path = join(directory, name)
    await writeFile(path, value, { mode: 0o600 })
    return path
  }
  const tokenFile = await writeSecret("hermes-token", "hermes-token")
  const invitationKey = await writeSecret("invitation-key", key)
  const configFile = join(directory, "proxy.json")
  await writeFile(
    configFile,
    JSON.stringify({
      version: 1,
      deploymentId: "test-deployment",
      listen: {
        host: "0.0.0.0",
        port: 4100,
        exposure: "private-container",
      },
      publicOrigin: "https://aos.example.test",
      runtime: {
        id: "hermes-main",
        kind: "hermes",
        baseUrl: "http://host.docker.internal:9119",
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
      guest: {
        listen: { host: "127.0.0.1", port: 4101 },
        publicOrigin: "https://guest.example.test",
        invitations: {
          keys: [{ id: "current", secretFile: invitationKey }],
          ttlSeconds: 259_200,
          clockSkewSeconds: 0,
        },
      },
      shutdownGraceMs: 5_000,
    })
  )
  return configFile
}

describe("proxy executable", () => {
  it("prints CLI help without reporting a startup failure", async () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    const start = vi.fn()

    await expect(
      runProxyCli(["bun", "proxy", "--help"], { logger, start })
    ).resolves.toBeUndefined()
    expect(start).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([
    [undefined, undefined],
    ["true", true],
  ] as const)(
    "starts both listeners with guest slash commands %s and closes the runtime exactly once",
    async (environmentValue, expectedFlag) => {
      const shutdowns: Array<ReturnType<typeof vi.fn>> = []
      const transportClose = vi.fn(async () => undefined)
      const staticHandler = vi.fn(async () => new Response("shell"))
      const exit = vi.fn()
      const logger = { info: vi.fn(), error: vi.fn() }
      /** Models one listener: shutdown announces, closes resources, settles. */
      const start = vi.fn((options: Parameters<typeof startProxyServer>[0]) => {
        const shutdown = vi.fn(async () => {
          options.onShutdownStarted?.()
          await options.close?.()
          options.onSettled?.({ forced: false })
        })
        shutdowns.push(shutdown)
        return { server: { stop: vi.fn() }, shutdown }
      })
      const lifecycle = await runProxyCli(
        ["bun", "proxy", "serve", "--config", await proxyConfig()],
        {
          runtimeFactory: (config, limits) =>
            createHermesRuntime(config, limits, {
              transportFactory: () => ({
                request: vi.fn(),
                close: transportClose,
              }),
            }),
          logger,
          getenv: (name) =>
            name === "AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED"
              ? environmentValue
              : undefined,
          start,
          staticHandler,
          exit,
        }
      )

      expect(start).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          host: "0.0.0.0",
          port: 4100,
          sockets: [
            expect.objectContaining({ path: "/api/aos/v1/acp", maxPeers: 256 }),
          ],
        })
      )
      expect(start).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          host: "127.0.0.1",
          port: 4101,
          sockets: [
            expect.objectContaining({
              path: "/api/guest/v1/acp",
              maxPeers: 256,
            }),
          ],
        })
      )
      expect(start.mock.calls[0]![0].close).toBeInstanceOf(Function)
      expect(start.mock.calls[1]![0].close).toBeInstanceOf(Function)
      const guestApp = start.mock.calls[1]![0].app
      expect(
        await (
          await guestApp.fetch(
            new Request("https://guest.example.test/runtime-config.json")
          )
        )?.json()
      ).toEqual({
        surface: "guest",
        basePath: "/api/guest/v1",
        lane: "guest",
        ...(expectedFlag ? { composerSlashCommandsEnabled: true } : {}),
      })
      const guestDocument = await guestApp.fetch(
        new Request("https://guest.example.test/")
      )
      expect(guestDocument?.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'"
      )
      expect(guestDocument?.headers.get("content-security-policy")).toContain(
        "img-src 'self' https: data: blob:"
      )
      expect(guestDocument?.headers.get("referrer-policy")).toBe("no-referrer")
      for (const reservedPath of [
        "/auth",
        "/auth/callback",
        "/hermes",
        "/hermes/api/profiles",
      ]) {
        const response = await guestApp.fetch(
          new Request(`https://guest.example.test${reservedPath}`)
        )
        expect(response?.status).toBe(404)
        expect(response?.headers.get("x-content-type-options")).toBe("nosniff")
      }

      await lifecycle!.shutdown()
      await lifecycle!.shutdown()
      expect(shutdowns).toHaveLength(2)
      expect(shutdowns[0]).toHaveBeenCalledOnce()
      expect(shutdowns[1]).toHaveBeenCalledOnce()
      expect(transportClose).toHaveBeenCalledOnce()
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "proxy.shutdown.started",
          graceMs: 5_000,
        })
      )
      expect(logger.info).toHaveBeenCalledWith({
        event: "proxy.shutdown.completed",
        forced: false,
      })
      expect(
        logger.info.mock.calls.filter(
          ([entry]) =>
            (entry as { event: string }).event === "proxy.shutdown.started"
        )
      ).toHaveLength(1)
      expect(logger.error).not.toHaveBeenCalled()
      expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    }
  )

  it("documents the invite command and flags", async () => {
    let output = ""

    await expect(
      runProxyCli(["bun", "proxy", "invite", "--help"], {
        logger: { info: vi.fn(), error: vi.fn() },
        writeOut: (value) => {
          output += value
        },
      })
    ).resolves.toBeUndefined()

    expect(output).toContain("invite --agent NAME [flags]")
    for (const flag of [
      "--agent",
      "--ref",
      "--expires-in",
      "--prefill",
      "--instruction",
      "--lang",
      "--name",
      "--logo",
      "--accent",
      "--title",
      "--message",
    ])
      expect(output).toContain(flag)
  })

  it("generates a stable conversation reference when --ref is omitted", async () => {
    const configFile = await proxyConfig()
    let output = ""
    let entropyCall = 0

    await expect(
      runProxyCli(
        [
          "bun",
          "proxy",
          "invite",
          "--agent",
          "default",
          "--expires-in",
          "1h",
          "--prefill",
          "Hello",
          "--name",
          "AOS Interview",
          "--logo",
          "https://example.test/brand.png",
          "--accent",
          "#2563eb",
          "--instruction",
          "Start a fresh conversation.",
          "--lang",
          "en",
        ],
        {
          logger: { info: vi.fn(), error: vi.fn() },
          getenv: (name) =>
            name === "AOS_RUNTIME_PROXY_CONFIG" ? configFile : undefined,
          randomBytes: (size) => {
            entropyCall += 1
            return Buffer.alloc(size, entropyCall === 1 ? 0xab : 0xcd)
          },
          clock: () => Date.UTC(2026, 8, 15, 8),
          writeOut: (value) => {
            output += value
          },
        }
      )
    ).resolves.toBeUndefined()

    const url = new URL(output.trim())
    expect(url.origin).toBe("https://guest.example.test")
    expect(url.pathname).toBe("/")
    expect(url.search).toBe("")
    const token = new URLSearchParams(url.hash.slice(1)).get("invite")!
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
    ) as Record<string, unknown>
    expect(payload).toEqual({
      v: 1,
      iss: "aos-invite",
      aud: "aos-guest",
      dep: "test-deployment",
      runtime: "hermes-main",
      iat: Date.UTC(2026, 8, 15, 8) / 1_000,
      exp: Date.UTC(2026, 8, 15, 9) / 1_000,
      agent: "default",
      ref: "q6urq6urq6urq6urq6urqw",
      firstTurn: {
        instruction: "Start a fresh conversation.",
        prefill: "Hello",
      },
      ui: {
        lang: "en",
        name: "AOS Interview",
        logoUrl: "https://example.test/brand.png",
        accent: "#2563eb",
      },
    })
  })

  it("preserves an explicit trimmed --ref without generating one", async () => {
    const configFile = await proxyConfig()
    let output = ""

    await expect(
      runProxyCli(
        [
          "bun",
          "proxy",
          "invite",
          "--agent",
          "default",
          "--ref",
          " returning-guest ",
          "--instruction",
          "Continue.",
        ],
        {
          logger: { info: vi.fn(), error: vi.fn() },
          getenv: (name) =>
            name === "AOS_RUNTIME_PROXY_CONFIG" ? configFile : undefined,
          randomBytes: () => {
            throw new Error("reference randomness was read")
          },
          writeOut: (value) => {
            output += value
          },
        }
      )
    ).resolves.toBeUndefined()

    const token = new URLSearchParams(new URL(output.trim()).hash.slice(1)).get(
      "invite"
    )!
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
    ) as Record<string, unknown>
    expect(payload.ref).toBe("returning-guest")
    expect(payload.exp - payload.iat).toBe(72 * 60 * 60)
  })

  it("defaults to 72 hours and does not require a first-turn instruction", async () => {
    const configFile = await proxyConfig()
    let output = ""
    await runProxyCli(["bun", "proxy", "invite", "--agent", "default"], {
      logger: { info: vi.fn(), error: vi.fn() },
      getenv: (name) =>
        name === "AOS_RUNTIME_PROXY_CONFIG" ? configFile : undefined,
      randomBytes: (size) => Buffer.alloc(size, 1),
      clock: () => Date.UTC(2026, 8, 15, 8),
      writeOut: (value) => {
        output += value
      },
    })

    const token = new URLSearchParams(new URL(output.trim()).hash.slice(1)).get(
      "invite"
    )!
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
    ) as Record<string, unknown>
    expect(payload.exp).toBe(Date.UTC(2026, 8, 18, 8) / 1_000)
    expect(payload).not.toHaveProperty("firstTurn")
  })
})
