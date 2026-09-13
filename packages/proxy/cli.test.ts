import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runProxyCli } from "./cli"

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("proxy executable", () => {
  it("prints CLI help without reporting a startup failure", async () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    const start = vi.fn()

    await expect(
      runProxyCli(["bun", "proxy", "--help"], {
        logger,
        start,
      })
    ).resolves.toBeUndefined()
    expect(start).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("starts separate operator and guest Bun listeners and shuts down both", async () => {
    vi.stubEnv("AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED", " TRUE ")
    const directory = await mkdtemp(join(tmpdir(), "aos-proxy-cli-"))
    temporaryDirectories.push(directory)
    const operatorSecret = join(directory, "operator-secret")
    const principalKey = join(directory, "principal-key")
    const sessionKey = join(directory, "session-key")
    const cursorKey = join(directory, "cursor-key")
    const hermesToken = join(directory, "hermes-token")
    const guestHermesToken = join(directory, "guest-hermes-token")
    const guestInvitationKey = join(directory, "guest-invitation-key")
    const configFile = join(directory, "proxy.json")
    await writeFile(operatorSecret, "operator-secret", { mode: 0o600 })
    const encodedKey = Buffer.alloc(32, 7).toString("base64url")
    await writeFile(principalKey, encodedKey, { mode: 0o600 })
    await writeFile(sessionKey, encodedKey, { mode: 0o600 })
    await writeFile(cursorKey, encodedKey, { mode: 0o600 })
    await writeFile(hermesToken, "hermes-token", { mode: 0o600 })
    await writeFile(guestHermesToken, "guest-hermes-token", { mode: 0o600 })
    await writeFile(guestInvitationKey, encodedKey, { mode: 0o600 })
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        listen: {
          host: "0.0.0.0",
          port: 4100,
          exposure: "private-container",
        },
        publicOrigin: "https://aos.example.test",
        operator: {
          issuer: "https://identity.example.test",
          clientId: "aos-ui",
          clientSecretFile: operatorSecret,
          principalHmacKeyFile: principalKey,
          redirectUri:
            "https://aos.example.test/api/aos/v1/auth/operator/callback",
          allowedSubjects: ["operator@example.test"],
          session: {
            deploymentId: "test-deployment",
            keys: [{ id: "current", secretFile: sessionKey }],
            ttlSeconds: 900,
          },
        },
        hermes: {
          baseUrl: "http://host.docker.internal:9119",
          auth: { mode: "static-token", tokenFile: hermesToken },
        },
        events: {
          activeKeyId: "current",
          keys: [{ id: "current", secretFile: cursorKey }],
        },
        guest: {
          listen: { host: "127.0.0.1", port: 4101 },
          publicOrigin: "https://guest.example.test",
          hermes: {
            baseUrl: "http://host.docker.internal:9120",
            tokenFile: guestHermesToken,
          },
          invitations: {
            keys: [{ id: "current", secretFile: guestInvitationKey }],
            ttlSeconds: 300,
            clockSkewSeconds: 0,
          },
        },
        shutdownGraceMs: 5_000,
      })
    )
    const shutdowns: Array<ReturnType<typeof vi.fn>> = []
    const staticHandler = vi.fn(async () => new Response("shell"))
    const start = vi.fn(() => {
      const shutdown = vi.fn(async () => undefined)
      shutdowns.push(shutdown)
      return { server: { stop: vi.fn() }, shutdown }
    })

    const lifecycle = await runProxyCli(
      ["bun", "proxy", "--config", configFile],
      {
        transportFactory: () => ({
          request: vi.fn(),
          authState: vi.fn(async () => ({ status: "authenticated" as const })),
        }),
        logger: { info: vi.fn(), error: vi.fn() },
        start,
        staticHandler,
      }
    )

    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        host: "0.0.0.0",
        port: 4100,
        shutdownGraceMs: 5_000,
      })
    )
    const operatorApp = start.mock.calls[0]![0].app
    expect(
      await (
        await operatorApp.fetch(new Request("https://aos.example.test/"))
      )?.text()
    ).toBe("shell")
    const guestApp = start.mock.calls[1]![0].app
    const runtimeConfig = await guestApp.fetch(
      new Request("https://guest.example.test/runtime-config.json")
    )
    expect(await runtimeConfig?.json()).toEqual({
      surface: "guest",
      basePath: "/api/guest/v1",
      lane: "guest",
      composerSlashCommandsEnabled: true,
    })
    expect(staticHandler).toHaveBeenCalledOnce()
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        app: expect.any(Object),
        events: expect.objectContaining({
          authorizeUpgrade: expect.any(Function),
          open: expect.any(Function),
        }),
        eventsPath: "/api/guest/v1/events",
        host: "127.0.0.1",
        port: 4101,
        shutdownGraceMs: 5_000,
      })
    )
    await lifecycle!.shutdown()
    expect(shutdowns).toHaveLength(2)
    expect(shutdowns[0]).toHaveBeenCalledOnce()
    expect(shutdowns[1]).toHaveBeenCalledOnce()
  })
})
