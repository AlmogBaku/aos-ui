import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createConfiguredProxy } from "./composition"
import type { HermesRpcTransport } from "./hermes-adapter"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true }))
  )
})

async function secretFile(name: string, contents: string) {
  const directory = await mkdtemp(join(tmpdir(), "aos-configured-proxy-"))
  directories.push(directory)
  const path = join(directory, name)
  await writeFile(path, `${contents}\n`, { mode: 0o600 })
  return path
}

function config(clientSecretFile: string, auth: unknown) {
  return {
    version: 1,
    listen: { host: "127.0.0.1", port: 4100 },
    publicOrigin: "http://127.0.0.1:3000",
    operator: {
      issuer: "https://identity.example.test",
      clientId: "aos-ui",
      clientSecretFile,
      redirectUri: "http://127.0.0.1:4100/api/aos/v1/auth/operator/callback",
      allowedSubjects: ["operator@example.test"],
    },
    hermes: { baseUrl: "http://127.0.0.1:9119", auth },
    shutdownGraceMs: 5_000,
  }
}

describe("configured proxy composition", () => {
  it("loads OIDC and static Hermes secrets before constructing boundaries", async () => {
    const clientSecretFile = await secretFile("oidc", "oidc-secret")
    const tokenFile = await secretFile("hermes", "hermes-secret")
    const transportFactory = vi.fn(
      (options: {
        credentials: () => Promise<Readonly<Record<string, string>>>
      }) =>
        ({
          request: vi.fn(async () => ({ profiles: [] })),
          authState: vi.fn(async () => ({
            status: "authenticated" as const,
            method: "static-token" as const,
          })),
          credentials: options.credentials,
        }) as HermesRpcTransport & { credentials: typeof options.credentials }
    )
    const verifySession = vi.fn(async () => ({
      subject: "operator@example.test",
    }))
    const operatorVerifierFactory = vi.fn(() => verifySession)

    const configured = await createConfiguredProxy(
      config(clientSecretFile, { mode: "static-token", tokenFile }),
      {
        operatorVerifierFactory,
        transportFactory,
        logger: { info: vi.fn(), error: vi.fn() },
      }
    )

    expect(operatorVerifierFactory).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "oidc-secret" })
    )
    const transport = transportFactory.mock.results[0].value
    await expect(transport.credentials()).resolves.toEqual({
      "X-Hermes-Session-Token": "hermes-secret",
    })
    expect(configured.config.hermes.auth.mode).toBe("static-token")
  })

  it("reports browser authentication as unavailable until a broker is supplied", async () => {
    const clientSecretFile = await secretFile("oidc", "oidc-secret")
    const configured = await createConfiguredProxy(
      config(clientSecretFile, { mode: "browser-broker" }),
      {
        operatorVerifierFactory: vi.fn(() =>
          vi.fn(async () => ({ subject: "operator@example.test" }))
        ),
        transportFactory: vi.fn(),
        logger: { info: vi.fn(), error: vi.fn() },
      }
    )
    const response = await configured.app.request("/api/aos/v1/auth/hermes", {
      headers: { cookie: "aos_operator=valid" },
    })
    expect(await response.json()).toEqual({
      status: "unavailable",
      reason: "not-configured",
    })
  })
})
