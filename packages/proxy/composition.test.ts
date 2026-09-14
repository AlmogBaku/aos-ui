// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { HermesRpcTransport } from "./adapters/hermes/adapter"
import {
  HermesAuthenticationError,
  type HermesWebSocketRpcTransportOptions,
} from "./adapters/hermes/transport"
import { createConfiguredProxy } from "./composition"

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

async function configuration(withGuest = false) {
  const key = Buffer.alloc(32, 7).toString("base64url")
  const tokenFile = await secretFile("hermes-token", "hermes-secret")
  const cursorKey = await secretFile("cursor-key", key)
  const invitationKey = withGuest
    ? await secretFile("invitation-key", key)
    : undefined
  return {
    version: 1,
    deploymentId: "test-deployment",
    listen: { host: "127.0.0.1", port: 4100 },
    publicOrigin: "https://aos.example.test",
    runtime: {
      id: "hermes-main",
      kind: "hermes",
      baseUrl: "http://127.0.0.1:9119",
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
    ...(withGuest
      ? {
          guest: {
            listen: { host: "127.0.0.1", port: 4101 },
            publicOrigin: "https://guest.example.test",
            invitations: {
              keys: [{ id: "guest-current", secretFile: invitationKey! }],
              ttlSeconds: 300,
              clockSkewSeconds: 0,
            },
          },
        }
      : {}),
    shutdownGraceMs: 5_000,
  }
}

function profile() {
  return {
    name: "researcher",
    display_name: "Researcher",
    ui_meta: { "hermes-bots": { hidden: false } },
    ui_meta_revisions: { "hermes-bots": 1 },
  }
}

describe("configured proxy composition", () => {
  it("starts a trusted operator app without OIDC or operator cookies", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [] } : undefined
    )
    const configured = await createConfiguredProxy(await configuration(), {
      transportFactory: () => ({ request }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/agents"
    )

    expect(response.status).toBe(200)
    expect(request).toHaveBeenCalledWith("profiles.list", {
      include_sessions: false,
    })
  })

  it("loads one server token and shares one runtime and transport across both lanes", async () => {
    const transportClose = vi.fn(async () => undefined)
    const transportFactory = vi.fn(
      (options: HermesWebSocketRpcTransportOptions) =>
        ({
          request: vi.fn(async (method: string) =>
            method === "profiles.list" ? { profiles: [profile()] } : undefined
          ),
          close: transportClose,
          credentials: options.credentials,
        }) as HermesRpcTransport & { credentials: typeof options.credentials }
    )
    const configured = await createConfiguredProxy(await configuration(true), {
      transportFactory,
      logger: { info: vi.fn(), error: vi.fn() },
      clock: () => 1_700_000_000_000,
    })

    expect(transportFactory).toHaveBeenCalledOnce()
    expect(configured.guest?.runtimeInstance).toBe(configured.runtimeInstance)
    expect(configured.runtimeInstance.runtime).toBe(configured.hermes)
    expect(configured.transport).toBe(transportFactory.mock.results[0]?.value)
    await expect(
      transportFactory.mock.results[0]?.value.credentials()
    ).resolves.toEqual({ "X-Hermes-Session-Token": "hermes-secret" })

    await configured.runtimeInstance.close()
    await configured.runtimeInstance.close()
    expect(transportClose).toHaveBeenCalledOnce()
  })

  it("validates an invitation runtime before accessing Hermes", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [profile()] } : undefined
    )
    const configured = await createConfiguredProxy(await configuration(true), {
      transportFactory: () => ({ request }),
      logger: { info: vi.fn(), error: vi.fn() },
      clock: () => 1_700_000_000_000,
    })
    const body = {
      principalId: "guest_recipient",
      invitationId: "invite_public",
      runtimeId: "another-runtime",
      agentId: "researcher",
      operations: ["messages:read"],
      capabilities: ["message-text"],
    }

    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/guest-invitations",
      {
        method: "POST",
        headers: {
          origin: "https://aos.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }
    )

    expect(response.status).toBe(404)
    expect(request).not.toHaveBeenCalled()
  })

  it("keeps liveness up and reports rejected Hermes credentials as not ready", async () => {
    const configured = await createConfiguredProxy(await configuration(), {
      transportFactory: () => ({
        request: vi.fn(async () => {
          throw new HermesAuthenticationError()
        }),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(
      (
        await configured.app.request(
          "https://aos.example.test/api/aos/v1/healthz"
        )
      ).status
    ).toBe(200)
    expect(
      (
        await configured.app.request(
          "https://aos.example.test/api/aos/v1/readyz"
        )
      ).status
    ).toBe(503)
  })
})
