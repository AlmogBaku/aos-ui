// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { captureLogs } from "../../test/support/log-capture"
import type { HermesRpcTransport } from "./adapters/hermes/adapter"
import { createHermesRuntime } from "./adapters/hermes/factory"
import {
  HermesAuthenticationError,
  type HermesGatewayOptions,
} from "./adapters/hermes/gateway"
import { CAPABILITIES } from "./acp/test-harness"
import { createConfiguredProxy } from "./composition"
import { sessionId } from "./core/ids"
import type { RuntimeInstance, ServerRuntime } from "./core/runtime"
import { SessionCoordinator } from "./core/session-coordinator"
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
    limits: {
      activeExecutions: 256,
      guestActiveExecutions: 32,
      operatorEventPeers: 256,
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

/** A state directory beside a VAPID private key, as a deployment configures it. */
async function pushConfiguration(stateDir?: string) {
  const privateKeyFile = await secretFile(
    "vapid-private-key",
    Buffer.alloc(32, 9).toString("base64url")
  )
  return {
    stateDir: stateDir ?? join(privateKeyFile, ".."),
    vapid: {
      subject: "mailto:ops@example.test",
      privateKeyFile,
    },
  }
}

/** A runtime whose coordinator only records who subscribes to it. */
function observableRuntime() {
  const subscribeExecutions = vi.fn(() => vi.fn())
  const runtimeInstance = {
    id: "test-runtime",
    runtime: {
      runtimeInfo: async () => ({ status: "ready" }),
      publicError: () => undefined,
      turns: {},
    },
    sessions: { subscribeExecutions, bindCapabilities: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as RuntimeInstance
  return { subscribeExecutions, runtimeInstance }
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
    const runtimeInfo = vi.fn(async () => ({
      id: "test-runtime",
      kind: "test",
      status: "ready",
      capabilities: {},
    }))
    const runtime = { runtimeInfo, turns: {} } as unknown as ServerRuntime
    const runtimeInstance = {
      id: "test-runtime",
      runtime,
      sessions: { bindCapabilities: vi.fn() },
      close: vi.fn(async () => undefined),
    } as unknown as RuntimeInstance
    const runtimeFactory = vi.fn(async () => runtimeInstance)

    const configured = await createConfiguredProxy(input, {
      runtimeFactory,
      logger: captureLogs().logger,
    })

    expect(runtimeFactory).toHaveBeenCalledOnce()
    expect(runtimeFactory).toHaveBeenCalledWith(
      input.runtime,
      input.limits,
      new Map()
    )
    expect(configured.runtimeInstance).toBe(runtimeInstance)
    expect(configured.guest?.runtimeInstance).toBe(runtimeInstance)
    // The guest listener serves ACP beside its HTTP routes.
    expect(configured.guest?.acpService.authorizeUpgrade).toBeInstanceOf(
      Function
    )
    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/readyz"
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      runtime: "ready",
    })
    expect(runtimeInfo).toHaveBeenCalledOnce()
  })

  it("starts a trusted operator app without OIDC or operator cookies", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [] } : undefined
    )
    const configured = await createConfiguredProxy(await configuration(), {
      runtimeFactory: hermesRuntimeFactory(() => ({ request })),
      logger: captureLogs().logger,
    })

    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/runtime"
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(request).toHaveBeenCalledWith("profiles.list", {
      include_sessions: false,
    })
  })

  it("loads one server token and shares one runtime and transport across both listeners", async () => {
    const transportClose = vi.fn(async () => undefined)
    const transportFactory = vi.fn(
      (options: HermesGatewayOptions) =>
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
      logger: captureLogs().logger,
      clock: () => 1_700_000_000_000,
    })

    expect(transportFactory).toHaveBeenCalledOnce()
    expect(configured.guest?.runtimeInstance).toBe(configured.runtimeInstance)
    // An operator and a guest on one provider Session meet in one channel.
    expect(configured.acpService.channels).toBeDefined()
    expect(configured.guest?.acpService.channels).toBe(
      configured.acpService.channels
    )
    await expect(
      transportFactory.mock.results[0]?.value.credentials()
    ).resolves.toEqual({ "X-Hermes-Session-Token": "hermes-secret" })

    await configured.runtimeInstance.close()
    await configured.runtimeInstance.close()
    expect(transportClose).toHaveBeenCalledOnce()
  })

  it("issues invitations through the trusted operator HTTP surface", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [profile()] } : undefined
    )
    const configured = await createConfiguredProxy(await configuration(true), {
      runtimeFactory: hermesRuntimeFactory(() => ({ request })),
      logger: captureLogs().logger,
      clock: () => 1_700_000_000_000,
    })
    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/guest-invitations",
      {
        method: "POST",
        headers: {
          origin: "https://aos.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent: " researcher ",
          ref: "guest-ref",
          expiresIn: "5m",
          prefill: "Welcome",
          instruction: "Load the interview skill.",
          lang: "en",
          title: "Interview",
        }),
      }
    )

    expect(response.status).toBe(201)
    const { url } = (await response.json()) as { url: string }
    expect(url).toMatch(/^https:\/\/guest\.example\.test\/#invite=/u)
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get("invite")
    await expect(
      configured.guest?.invitations.verify(token!)
    ).resolves.toMatchObject({
      agentId: "researcher",
      ref: "guest-ref",
      expiresAt: 1_700_000_300,
      firstTurn: {
        prefill: "Welcome",
        instruction: "Load the interview skill.",
      },
      ui: { lang: "en", title: "Interview" },
    })
    expect(request).toHaveBeenCalledWith("profiles.list", {
      include_sessions: false,
    })
  })

  it("issues invitations without an Origin header", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [profile()] } : undefined
    )
    const configured = await createConfiguredProxy(await configuration(true), {
      runtimeFactory: hermesRuntimeFactory(() => ({ request })),
      logger: captureLogs().logger,
    })

    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/guest-invitations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "researcher",
          ref: "guest-ref",
          expiresIn: "5m",
        }),
      }
    )

    expect(response.status).toBe(201)
  })

  it("names the rejected field when invitation input is invalid", async () => {
    const configured = await createConfiguredProxy(await configuration(true), {
      runtimeFactory: hermesRuntimeFactory(() => ({ request: vi.fn() })),
      logger: captureLogs().logger,
    })
    const post = (body: unknown) =>
      configured.app.request(
        "https://aos.example.test/api/aos/v1/guest-invitations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expiresIn: "5m", ...body }),
        }
      )

    for (const [body, reason] of [
      [{ agent: "researcher", title: "x".repeat(300) }, "title: too long"],
      [
        { agent: "researcher", agentId: "researcher" },
        "unknown field(s): agentId",
      ],
      [
        { agent: "researcher", expiresIn: "soon" },
        "expiresIn: must be a positive duration",
      ],
      [
        { agent: "researcher", instruction: "x".repeat(2_001) },
        "instruction: too long",
      ],
    ] as const) {
      const response = await post(body)
      expect(response.status).toBe(400)
      const { error } = (await response.json()) as {
        error: { code: string; description: string }
      }
      expect(error.code).toBe("invalid_request")
      expect(error.description).toContain(reason)
    }
  })

  it("does not return an invitation for an unknown Agent", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [profile()] } : undefined
    )
    const configured = await createConfiguredProxy(await configuration(true), {
      runtimeFactory: hermesRuntimeFactory(() => ({ request })),
      logger: captureLogs().logger,
    })

    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/guest-invitations",
      {
        method: "POST",
        headers: {
          origin: "https://aos.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agent: "missing", expiresIn: "5m" }),
      }
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    })
  })

  it("wires push delivery to the runtime and the operator listener's own rows", async () => {
    const { subscribeExecutions, runtimeInstance } = observableRuntime()
    const input = {
      ...(await configuration()),
      push: await pushConfiguration(),
    }

    const configured = await createConfiguredProxy(input, {
      runtimeFactory: async () => runtimeInstance,
      logger: captureLogs().logger,
    })

    // One cache: the ACP listener keeps it current and the read-state gate reads it.
    expect(configured.acpService.sessionRows).toBe(configured.sessionRows)
    expect(subscribeExecutions).toHaveBeenCalledOnce()
    expect(configured.push?.registrations.list("operator")).toEqual([])

    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/push"
    )
    expect(response.status).toBe(200)
    const info = (await response.json()) as { publicKey: string }
    expect(info).toEqual({
      status: "available",
      publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{87}$/u),
    })
    expect(JSON.stringify(info)).not.toContain(
      Buffer.alloc(32, 9).toString("base64url")
    )
  })

  it("serves no push capability when a deployment configures none", async () => {
    const { runtimeInstance, subscribeExecutions } = observableRuntime()

    const configured = await createConfiguredProxy(await configuration(), {
      runtimeFactory: async () => runtimeInstance,
      logger: captureLogs().logger,
    })

    expect(configured.push).toBeUndefined()
    expect(subscribeExecutions).not.toHaveBeenCalled()
    await expect(
      (
        await configured.app.request("https://aos.example.test/api/aos/v1/push")
      ).json()
    ).resolves.toEqual({ status: "not-configured" })
  })

  it("refuses to start when the push state directory is not there", async () => {
    const { runtimeInstance } = observableRuntime()
    const input = {
      ...(await configuration()),
      push: await pushConfiguration("/var/lib/aos-ui/missing-push-state"),
    }

    await expect(
      createConfiguredProxy(input, {
        runtimeFactory: async () => runtimeInstance,
        logger: captureLogs().logger,
      })
    ).rejects.toThrow("Push state directory")
  })

  describe("voice providers", () => {
    /** A runtime whose native speech fails, as OpenCode's and OpenClaw's do. */
    function speechlessRuntime() {
      const speak = vi.fn(async () => {
        throw new Error("native speech unavailable")
      })
      const runtime = {
        runtimeInfo: async () => ({ status: "ready" }),
        publicError: () => undefined,
        workspaceCapabilities: async () => CAPABILITIES,
        speak,
        turns: {},
      } as unknown as ServerRuntime
      const runtimeInstance = {
        id: "test-runtime",
        runtime,
        sessions: new SessionCoordinator({
          engine: runtime.turns,
          readings: runtime,
          maxActiveExecutions: 1,
          maxSubscriberEvents: 1,
          maxSubscriberBytes: 1,
        }),
        close: vi.fn(async () => undefined),
      } as unknown as RuntimeInstance
      return { speak, runtimeInstance }
    }

    async function voiceConfiguration(apiKeyFile: string) {
      return {
        ...(await configuration()),
        voice: {
          speech: {
            provider: "openai-compatible",
            baseUrl: "https://tts.example.test/v1",
            apiKeyFile,
            model: "tts-1",
            voice: "alloy",
          },
        },
      }
    }

    it("reads the provider key once and serves speech the runtime cannot", async () => {
      const { speak, runtimeInstance } = speechlessRuntime()
      const audio = Uint8Array.from([1, 2, 3])
      const fetchImpl = vi.fn(
        async () => new Response(audio, { status: 200 })
      ) as unknown as typeof fetch
      const logs = captureLogs()

      const configured = await createConfiguredProxy(
        await voiceConfiguration(await secretFile("voice-key", "tts-secret")),
        {
          runtimeFactory: async () => runtimeInstance,
          logger: logs.logger,
          fetch: fetchImpl,
        }
      )
      const response = await configured.app.request(
        "https://aos.example.test/api/aos/v1/agents/researcher/audio/speak",
        {
          method: "POST",
          headers: {
            origin: "https://aos.example.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "Hello" }),
        }
      )

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("audio/mpeg")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio)
      // Fallback tried the runtime first, then said so without the text.
      expect(speak).toHaveBeenCalledOnce()
      expect(logs.records()).toContainEqual({
        level: "info",
        message: "voice.fallback",
        fields: expect.objectContaining({ direction: "speech" }),
      })
      expect(JSON.stringify(logs.records())).not.toContain("Hello")
      const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit]
      expect(url).toBe("https://tts.example.test/v1/audio/speech")
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer tts-secret"
      )
      // A Session's capabilities offer the provider's speech too.
      const capabilities = await new Promise<{ content: { speech: unknown } }>(
        (resolve) =>
          runtimeInstance.sessions.subscribeCapabilities(
            { agentId: "researcher", sessionId: sessionId("session-1") },
            "browser-1",
            async (value) => resolve(value)
          )
      )
      expect(capabilities.content.speech).toEqual(
        expect.objectContaining({ status: "available", scope: "agent" })
      )
      // Both listeners and readiness still see one runtime instance.
      expect(configured.guest).toBeUndefined()
      expect(
        (
          await configured.app.request(
            "https://aos.example.test/api/aos/v1/readyz"
          )
        ).status
      ).toBe(200)
    })

    it("refuses to start on a provider key file another user can read", async () => {
      const { runtimeInstance } = speechlessRuntime()
      const keyFile = await secretFile("voice-key", "tts-secret")
      await chmod(keyFile, 0o644)

      await expect(
        createConfiguredProxy(await voiceConfiguration(keyFile), {
          runtimeFactory: async () => runtimeInstance,
          logger: captureLogs().logger,
        })
      ).rejects.toThrow("Secret file permissions are too broad")
    })
  })

  it("keeps liveness up and reports rejected Hermes credentials as not ready", async () => {
    const configured = await createConfiguredProxy(await configuration(), {
      runtimeFactory: hermesRuntimeFactory(() => ({
        request: vi.fn(async () => {
          throw new HermesAuthenticationError()
        }),
      })),
      logger: captureLogs().logger,
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
