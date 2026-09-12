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
        operatorVerifierFactory: () => async () => undefined,
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
    const hermesToken = join(directory, "hermes-token")
    const configFile = join(directory, "proxy.json")
    await writeFile(operatorSecret, "operator-secret", { mode: 0o600 })
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
        publicOrigin: "http://127.0.0.1:3000",
        operator: {
          issuer: "https://identity.example.test",
          clientId: "aos-ui",
          clientSecretFile: operatorSecret,
          redirectUri:
            "http://127.0.0.1:3000/api/aos/v1/auth/operator/callback",
          allowedSubjects: ["operator@example.test"],
        },
        hermes: {
          baseUrl: "http://host.docker.internal:9119",
          auth: { mode: "static-token", tokenFile: hermesToken },
        },
        shutdownGraceMs: 5_000,
      })
    )
    const start = vi.fn(() => ({
      server: { stop: vi.fn() },
      shutdown: vi.fn(async () => undefined),
    }))

    await runProxyCli(["bun", "proxy", "--config", configFile], {
      operatorVerifierFactory: () => async () => undefined,
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
