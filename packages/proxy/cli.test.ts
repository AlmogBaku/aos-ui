import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runProxyCli } from "./cli"

const temporaryDirectories: string[] = []

afterEach(async () => {
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

  it("loads the private config and starts the configured Bun listener", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aos-proxy-cli-"))
    temporaryDirectories.push(directory)
    const operatorSecret = join(directory, "operator-secret")
    const principalKey = join(directory, "principal-key")
    const sessionKey = join(directory, "session-key")
    const cursorKey = join(directory, "cursor-key")
    const hermesToken = join(directory, "hermes-token")
    const configFile = join(directory, "proxy.json")
    await writeFile(operatorSecret, "operator-secret", { mode: 0o600 })
    const encodedKey = Buffer.alloc(32, 7).toString("base64url")
    await writeFile(principalKey, encodedKey, { mode: 0o600 })
    await writeFile(sessionKey, encodedKey, { mode: 0o600 })
    await writeFile(cursorKey, encodedKey, { mode: 0o600 })
    await writeFile(hermesToken, "hermes-token", { mode: 0o600 })
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
        shutdownGraceMs: 5_000,
      })
    )
    const start = vi.fn(() => ({
      server: { stop: vi.fn() },
      shutdown: vi.fn(async () => undefined),
    }))

    await runProxyCli(["bun", "proxy", "--config", configFile], {
      transportFactory: () => ({
        request: vi.fn(),
        authState: vi.fn(async () => ({ status: "authenticated" as const })),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
      start,
    })

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "0.0.0.0",
        port: 4100,
        shutdownGraceMs: 5_000,
      })
    )
  })
})
