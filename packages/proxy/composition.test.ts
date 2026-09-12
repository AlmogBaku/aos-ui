// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { OidcProvider } from "./auth/oidc"
import { createConfiguredProxy } from "./composition"
import type { HermesRpcTransport } from "./runtimes/hermes/adapter"
import {
  HermesAuthenticationError,
  type HermesWebSocketRpcTransportOptions,
} from "./runtimes/hermes/transport"

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

async function secrets() {
  const encodedKey = Buffer.alloc(32, 7).toString("base64url")
  return {
    clientSecretFile: await secretFile("oidc", "oidc-secret"),
    principalHmacKeyFile: await secretFile("principal", encodedKey),
    sessionKeyFile: await secretFile("session", encodedKey),
    cursorKeyFile: await secretFile("cursor", encodedKey),
  }
}

function config(files: Awaited<ReturnType<typeof secrets>>, auth: unknown) {
  return {
    version: 1,
    listen: { host: "127.0.0.1", port: 4100 },
    publicOrigin: "https://aos.example.test",
    operator: {
      issuer: "https://identity.example.test",
      clientId: "aos-ui",
      clientSecretFile: files.clientSecretFile,
      principalHmacKeyFile: files.principalHmacKeyFile,
      redirectUri: "https://aos.example.test/api/aos/v1/auth/operator/callback",
      allowedSubjects: ["operator@example.test"],
      session: {
        deploymentId: "test-deployment",
        keys: [{ id: "current", secretFile: files.sessionKeyFile }],
        ttlSeconds: 900,
      },
    },
    hermes: { baseUrl: "http://127.0.0.1:9119", auth },
    events: {
      activeKeyId: "current",
      keys: [{ id: "current", secretFile: files.cursorKeyFile }],
    },
    shutdownGraceMs: 5_000,
  }
}

const provider: OidcProvider = {
  buildAuthorizationUrl(parameters) {
    const url = new URL("https://identity.example.test/authorize")
    for (const [key, value] of Object.entries(parameters))
      url.searchParams.set(key, value)
    return url
  },
  authorizationCodeGrant: vi.fn(async () => ({
    issuer: "https://identity.example.test",
    subject: "operator@example.test",
  })),
}

describe("configured proxy composition", () => {
  it("constructs an isolated guest listener and Hermes transport from separate secrets", async () => {
    const files = await secrets()
    const operatorTokenFile = await secretFile(
      "hermes-operator",
      "operator-token"
    )
    const guestTokenFile = await secretFile("hermes-guest", "guest-token")
    const guestKeyFile = await secretFile(
      "guest-invitation",
      Buffer.alloc(32, 8).toString("base64url")
    )
    const transportFactory = vi.fn(
      (options: HermesWebSocketRpcTransportOptions) =>
        ({
          request: vi.fn(),
          credentials: options.credentials,
        }) as HermesRpcTransport & { credentials: typeof options.credentials }
    )
    const input = {
      ...config(files, { mode: "static-token", tokenFile: operatorTokenFile }),
      guest: {
        listen: { host: "127.0.0.1", port: 4101 },
        publicOrigin: "https://guest.example.test",
        hermes: {
          baseUrl: "http://127.0.0.1:9120",
          tokenFile: guestTokenFile,
        },
        invitations: {
          keys: [{ id: "guest-current", secretFile: guestKeyFile }],
          ttlSeconds: 300,
          clockSkewSeconds: 0,
        },
      },
    }

    const configured = await createConfiguredProxy(input, {
      oidcProvider: provider,
      transportFactory,
      logger: { info: vi.fn(), error: vi.fn() },
      clock: () => 1_700_000_000_000,
    })

    expect(transportFactory).toHaveBeenCalledTimes(2)
    expect(transportFactory.mock.calls[1]?.[0]).toMatchObject({
      baseUrl: "http://127.0.0.1:9120",
    })
    await expect(
      transportFactory.mock.results[1]?.value.credentials()
    ).resolves.toEqual({ "X-Hermes-Session-Token": "guest-token" })
    expect(configured.guest?.hermes).not.toBe(configured.hermes)
    expect(
      (
        await configured.guest!.service.app.request(
          "https://guest.example.test/api/aos/v1/runtime"
        )
      ).status
    ).toBe(404)

    const session = await configured.operatorSessions.issue({
      principalId: "aos_principal_test",
    })
    const invitation = await configured.app.request(
      "https://aos.example.test/api/aos/v1/guest-invitations",
      {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: "https://aos.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          principalId: "guest_recipient",
          invitationId: "invite_public",
          agentId: "researcher",
          sessionId: "hermes:researcher:stored",
          operations: ["messages:create", "messages:read"],
          capabilities: ["message-text"],
        }),
      }
    )
    expect(invitation.status).toBe(201)
    expect(await invitation.json()).toMatchObject({
      token: expect.any(String),
      grant: { agentId: "researcher", sessionId: "hermes:researcher:stored" },
    })
  })

  it("loads sealed-session keys and completes real OIDC PKCE before allowing operator requests", async () => {
    const files = await secrets()
    const tokenFile = await secretFile("hermes", "hermes-secret")
    const transportFactory = vi.fn(
      (options: {
        credentials: () => Promise<Readonly<Record<string, string>>>
      }) =>
        ({
          request: vi.fn(async () => ({ profiles: [] })),
          credentials: options.credentials,
        }) as HermesRpcTransport & { credentials: typeof options.credentials }
    )

    const configured = await createConfiguredProxy(
      config(files, { mode: "static-token", tokenFile }),
      {
        oidcProvider: provider,
        transportFactory,
        logger: { info: vi.fn(), error: vi.fn() },
        clock: () => 1_000,
      }
    )

    const start = await configured.app.request(
      "https://aos.example.test/api/aos/v1/auth/operator/start?return=%2Fresearcher"
    )
    expect(start.status).toBe(302)
    expect(start.headers.get("location")).toContain(
      "https://identity.example.test/authorize"
    )
    const flowCookie = start.headers.get("set-cookie")!
    const callback = await configured.app.request(
      "https://aos.example.test/api/aos/v1/auth/operator/callback?code=code&state=state",
      { headers: { cookie: flowCookie } }
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/researcher")
    const sessionCookie = (
      callback.headers as Headers & { getSetCookie(): string[] }
    )
      .getSetCookie()
      .find((value) => value.startsWith("__Host-aos-session="))!
    const operator = await configured.app.request(
      "https://aos.example.test/api/aos/v1/auth/operator",
      { headers: { cookie: sessionCookie } }
    )
    expect(await operator.json()).toEqual({
      status: "authenticated",
      operator: {
        id: expect.stringMatching(/^aos_principal_[A-Za-z0-9_-]+$/u),
      },
    })

    const transport = transportFactory.mock.results[0].value
    await expect(transport.credentials()).resolves.toEqual({
      "X-Hermes-Session-Token": "hermes-secret",
    })
  })

  it("probes static-token credentials and reports rejected tokens as runtime authentication required", async () => {
    const files = await secrets()
    const tokenFile = await secretFile("hermes", "expired-token")
    const request = vi.fn(async () => {
      throw new HermesAuthenticationError()
    })
    const configured = await createConfiguredProxy(
      config(files, { mode: "static-token", tokenFile }),
      {
        oidcProvider: provider,
        transportFactory: vi.fn(() => ({ request })),
        logger: { info: vi.fn(), error: vi.fn() },
      }
    )
    const session = await configured.operatorSessions.issue({
      principalId: "aos_principal_test",
    })

    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/auth/runtime",
      { headers: { cookie: session.cookie } }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "authentication-required",
    })
    expect(request).toHaveBeenCalledWith("profiles.list", {
      include_sessions: false,
    })
  })

  it("constructs the Hermes browser broker and reports normalized runtime auth", async () => {
    const files = await secrets()
    const state = vi.fn(() => ({ status: "authentication-required" as const }))
    const credentials = vi.fn(async () => ({ authorization: "Bearer native" }))
    const browserAuthBrokerFactory = vi.fn(() => ({
      authState: state,
      begin: vi.fn(),
      complete: vi.fn(),
      credentials,
      invalidate: vi.fn(),
    }))
    const transportFactory = vi.fn(
      (options: HermesWebSocketRpcTransportOptions) =>
        ({
          request: vi.fn(async () => ({ profiles: [] })),
          credentials: options.credentials,
        }) as HermesRpcTransport & { credentials: typeof options.credentials }
    )
    const configured = await createConfiguredProxy(
      config(files, {
        mode: "browser-broker",
        callbackUrl:
          "https://aos.example.test/api/aos/v1/auth/runtime/upstream/auth/callback",
        allowedIdentityOrigins: ["https://identity.example.test"],
        provider: "example",
      }),
      {
        oidcProvider: provider,
        browserAuthBrokerFactory,
        transportFactory,
        logger: { info: vi.fn(), error: vi.fn() },
      }
    )

    expect(browserAuthBrokerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:9119",
        publicOrigin: "https://aos.example.test",
        callbackUrl:
          "https://aos.example.test/api/aos/v1/auth/runtime/upstream/auth/callback",
        allowedIdentityOrigins: ["https://identity.example.test"],
        provider: "example",
      })
    )
    const issued = await configured.operatorSessions.issue({
      principalId: "aos_principal_test",
    })
    const response = await configured.app.request(
      "https://aos.example.test/api/aos/v1/auth/runtime",
      { headers: { cookie: issued.cookie } }
    )
    expect(await response.json()).toEqual({
      status: "authentication-required",
    })
    expect(state).toHaveBeenCalledWith({
      principalId: "aos_principal_test",
      lane: "operator",
    })

    const ready = await configured.app.request(
      "https://aos.example.test/api/aos/v1/readyz"
    )
    expect(ready.status).toBe(200)
    expect(await ready.json()).toMatchObject({ status: "ready" })

    state.mockReturnValue({ status: "authenticated" })
    const agents = await configured.app.request(
      "https://aos.example.test/api/aos/v1/agents",
      { headers: { cookie: issued.cookie } }
    )
    expect(agents.status).toBe(200)
    expect(transportFactory).toHaveBeenCalledTimes(1)
    const transport = transportFactory.mock.results[0].value
    await expect(transport.credentials()).resolves.toEqual({
      authorization: "Bearer native",
    })
    expect(credentials).toHaveBeenCalledWith({
      principalId: "aos_principal_test",
      lane: "operator",
    })

    await configured.app.request("https://aos.example.test/api/aos/v1/agents", {
      headers: { cookie: issued.cookie },
    })
    expect(transportFactory).toHaveBeenCalledTimes(2)
  })
})
