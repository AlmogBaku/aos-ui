// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { HermesRpcTransport } from "./adapters/hermes/adapter"
import { createHermesRuntime } from "./adapters/hermes/factory"
import {
  HermesAuthenticationError,
  type HermesWebSocketRpcTransportOptions,
} from "./adapters/hermes/transport"
import { createConfiguredProxy } from "./composition"
import type { RuntimeInstance, ServerRuntime } from "./core/runtime"
import type { RuntimeFactory } from "./adapters/create-runtime"

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

function hermesRuntimeFactory(
  transportFactory: NonNullable<
    Parameters<typeof createHermesRuntime>[2]
  >["transportFactory"]
): RuntimeFactory {
  return (config, limits) =>
    createHermesRuntime(config, limits, { transportFactory })
}

describe("configured proxy composition", () => {
  it("uses an injected provider-neutral runtime factory without reading adapter secrets", async () => {
    const input = await configuration(true)
    input.runtime.tokenFile = "/missing/provider-private-secret"
    const listAgents = vi.fn(async () => ({
      revision: "test-catalog-1",
      agents: [],
    }))
    const runtime = {
      runtimeInfo: vi.fn(async () => ({
        id: "test-runtime",
        kind: "test",
        status: "ready",
        capabilities: {},
      })),
      listAgents,
    } as unknown as ServerRuntime
    const runtimeInstance = {
      id: "test-runtime",
      runtime,
      sessions: {},
      close: vi.fn(async () => undefined),
    } as unknown as RuntimeInstance
    const runtimeFactory = vi.fn(async () => runtimeInstance)

    const configured = await createConfiguredProxy(input, {
      runtimeFactory,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(runtimeFactory).toHaveBeenCalledOnce()
    expect(runtimeFactory).toHaveBeenCalledWith(input.runtime, input.limits)
    expect(configured.runtimeInstance).toBe(runtimeInstance)
    expect(configured.guest?.runtimeInstance).toBe(runtimeInstance)
    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/agents"
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      revision: "test-catalog-1",
      agents: [],
    })
    expect(listAgents).toHaveBeenCalledOnce()
  })

  it("starts a trusted operator app without OIDC or operator cookies", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [] } : undefined
    )
    const configured = await createConfiguredProxy(await configuration(), {
      runtimeFactory: hermesRuntimeFactory(() => ({ request })),
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
      runtimeFactory: hermesRuntimeFactory(transportFactory),
      logger: { info: vi.fn(), error: vi.fn() },
      clock: () => 1_700_000_000_000,
    })

    expect(transportFactory).toHaveBeenCalledOnce()
    expect(configured.guest?.runtimeInstance).toBe(configured.runtimeInstance)
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
      runtimeFactory: hermesRuntimeFactory(() => ({ request })),
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
      runtimeFactory: hermesRuntimeFactory(() => ({
        request: vi.fn(async () => {
          throw new HermesAuthenticationError()
        }),
      })),
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
