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
  const cursorKey = await writeSecret("cursor-key", key)
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
      events: {
        activeKeyId: "current",
        keys: [{ id: "current", secretFile: cursorKey }],
      },
      limits: {
        activeExecutions: 256,
        guestActiveExecutions: 32,
        operatorEventPeers: 256,
        guestEventPeers: 64,
        guestEventPeersPerInvitation: 4,
        subscriberEvents: 512,
        subscriberBytes: 2_097_152,
      },
      guest: {
        listen: { host: "127.0.0.1", port: 4101 },
        publicOrigin: "https://guest.example.test",
        invitations: {
          keys: [{ id: "current", secretFile: invitationKey }],
          ttlSeconds: 300,
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

  it("starts both listeners over one runtime and closes it exactly once", async () => {
    const shutdowns: Array<ReturnType<typeof vi.fn>> = []
    const transportClose = vi.fn(async () => undefined)
    const staticHandler = vi.fn(async () => new Response("shell"))
    const start = vi.fn(() => {
      const shutdown = vi.fn(async () => undefined)
      shutdowns.push(shutdown)
      return { server: { stop: vi.fn() }, shutdown }
    })
    const lifecycle = await runProxyCli(
      ["bun", "proxy", "--config", await proxyConfig()],
      {
        transportFactory: () => ({
          request: vi.fn(),
          close: transportClose,
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
        maxEventPeers: 256,
      })
    )
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventsPath: "/api/guest/v1/events",
        host: "127.0.0.1",
        port: 4101,
        maxEventPeers: 64,
      })
    )
    expect(start.mock.calls[0]![0].close).toBeUndefined()
    expect(start.mock.calls[1]![0].close).toBeUndefined()
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
    })

    await lifecycle!.shutdown()
    await lifecycle!.shutdown()
    expect(shutdowns).toHaveLength(2)
    expect(shutdowns[0]).toHaveBeenCalledOnce()
    expect(shutdowns[1]).toHaveBeenCalledOnce()
    expect(transportClose).toHaveBeenCalledOnce()
  })
})
