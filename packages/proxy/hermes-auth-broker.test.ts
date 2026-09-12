import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import {
  HermesBrowserAuthenticationError,
  createHermesBrowserAuthBroker,
  type HermesBrowserAuthBinding,
} from "./hermes-auth-broker"

const callbackUrl =
  "https://aos.example.test/api/aos/v1/auth/hermes/upstream/auth/callback"
const identityOrigin = "https://identity.example.test"
const binding: HermesBrowserAuthBinding = {
  principalId: "operator:7",
  lane: "operator",
  browserSessionId: "browser-session-1",
  callbackUrl,
  returnPath: "/agents/research/sessions/42?view=chat#latest",
}

type NativeFixtureOptions = {
  authorizeOrigin?: string
  advertisedCallback?: string
  authFlows?: readonly string[]
  password?: boolean
  tokenStatus?: number
  refreshStatus?: number
}

function nativeFixture(options: NativeFixtureOptions = {}) {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  let nativeRedirect = ""
  let clientState = ""
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      )
      calls.push({ url, init })
      if (url.pathname === "/api/status") {
        return Response.json({
          auth_required: true,
          auth_flows: options.authFlows ?? ["cookie", "native_pkce"],
        })
      }
      if (url.pathname === "/api/auth/providers") {
        return Response.json({
          providers: [
            {
              name: "nous",
              display_name: "Nous Research",
              supports_password: options.password ?? false,
            },
          ],
        })
      }
      if (url.pathname === "/auth/native/authorize") {
        nativeRedirect = url.searchParams.get("redirect_uri") ?? ""
        clientState = url.searchParams.get("state") ?? ""
        const authorize = new URL(
          "/oauth/authorize",
          options.authorizeOrigin ?? identityOrigin
        )
        authorize.searchParams.set("state", `provider-state-${calls.length}`)
        authorize.searchParams.set(
          "redirect_uri",
          options.advertisedCallback ?? callbackUrl
        )
        return new Response(null, {
          status: 302,
          headers: {
            location: authorize.toString(),
            "set-cookie":
              "hermes_session_pkce=server-only; Path=/; Secure; HttpOnly",
          },
        })
      }
      if (url.pathname === "/auth/callback") {
        const cookie = new Headers(init?.headers).get("cookie")
        expect(cookie).toBe("hermes_session_pkce=server-only")
        const target = new URL(nativeRedirect)
        target.searchParams.set("code", "gateway-code")
        target.searchParams.set("state", clientState)
        return new Response(null, {
          status: 302,
          headers: {
            location: target.toString(),
            "set-cookie": "hermes_session_pkce=; Max-Age=0; Path=/",
          },
        })
      }
      if (url.pathname === "/auth/native/token") {
        if (options.tokenStatus)
          return new Response("native error body must stay private", {
            status: options.tokenStatus,
          })
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.code).toBe("gateway-code")
        expect(typeof body.code_verifier).toBe("string")
        return Response.json({
          access_token: "secret-access",
          refresh_token: "secret-refresh",
          token_type: "Bearer",
          expires_at: 4_000_000_000,
          provider: "nous",
          user_id: "native-user",
        })
      }
      if (url.pathname === "/auth/native/refresh") {
        if (options.refreshStatus)
          return new Response("refresh error must stay private", {
            status: options.refreshStatus,
          })
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_at: 4_000_000_000,
          provider: "nous",
          user_id: "native-user",
        })
      }
      throw new Error(`unexpected native path ${url.pathname}`)
    }
  )
  return { calls, fetcher }
}

function broker(
  fetcher: typeof fetch,
  overrides: Partial<Parameters<typeof createHermesBrowserAuthBroker>[0]> = {}
) {
  return createHermesBrowserAuthBroker({
    baseUrl: "http://127.0.0.1:9119",
    publicOrigin: "https://aos.example.test",
    callbackUrl,
    allowedIdentityOrigins: [identityOrigin],
    fetcher,
    randomBytes: (size) => new Uint8Array(size).fill(7),
    ...overrides,
  })
}

async function beginAndComplete(
  instance: ReturnType<typeof createHermesBrowserAuthBroker>,
  state = "provider-state-3"
) {
  const started = await instance.begin(binding)
  expect(started.status).toBe("redirect")
  if (started.status !== "redirect") throw new Error("expected redirect")
  return instance.complete({
    ...binding,
    callbackUrl: `${callbackUrl}?code=idp-code&state=${state}`,
  })
}

describe("Hermes external-browser authentication broker", () => {
  it("proxies the real native PKCE flow and retains native credentials server-side", async () => {
    const native = nativeFixture()
    const instance = broker(native.fetcher as typeof fetch)

    const started = await instance.begin(binding)

    expect(started.status).toBe("redirect")
    if (started.status !== "redirect") throw new Error("expected redirect")
    expect(started.response.status).toBe(302)
    expect(started.response.headers.get("location")).toMatch(
      /^https:\/\/identity\.example\.test\/oauth\/authorize/u
    )
    expect(started.response.headers.has("set-cookie")).toBe(false)

    const authorize = native.calls.find(
      ({ url }) => url.pathname === "/auth/native/authorize"
    )
    expect(authorize?.init?.redirect).toBe("manual")
    expect(authorize?.url.searchParams.get("code_challenge_method")).toBe(
      "S256"
    )
    const verifierHash = createHash("sha256")
      .update(Buffer.from(new Uint8Array(64).fill(7)).toString("base64url"))
      .digest("base64url")
    expect(authorize?.url.searchParams.get("code_challenge")).toBe(verifierHash)
    expect(authorize?.url.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1\/aos-hermes-native\//u
    )

    const completed = await instance.complete({
      ...binding,
      callbackUrl: `${callbackUrl}?code=idp-code&state=provider-state-3`,
    })

    expect(completed).toEqual({
      status: "authenticated",
      returnPath: binding.returnPath,
    })
    await expect(
      instance.credentials({
        principalId: binding.principalId,
        lane: binding.lane,
      })
    ).resolves.toEqual({ authorization: "Bearer secret-access" })
    expect(JSON.stringify({ started, completed })).not.toMatch(
      /secret-access|secret-refresh|127\.0\.0\.1:9119|server-only/u
    )
    expect(
      native.calls.every(({ url }) => url.origin === "http://127.0.0.1:9119")
    ).toBe(true)
  })

  it("consumes a callback flow once, including on replay", async () => {
    const native = nativeFixture()
    const instance = broker(native.fetcher as typeof fetch)
    await beginAndComplete(instance)

    await expect(
      instance.complete({
        ...binding,
        callbackUrl: `${callbackUrl}?code=idp-code&state=provider-state-3`,
      })
    ).rejects.toMatchObject({
      name: "HermesBrowserAuthenticationError",
      code: "invalid-flow",
      message: "Hermes authentication failed",
    })
  })

  it("expires flows and consumes them before reporting a binding substitution", async () => {
    let now = 10_000
    const native = nativeFixture()
    const instance = broker(native.fetcher as typeof fetch, {
      clock: () => now,
      flowTtlMs: 60_000,
    })
    await instance.begin(binding)
    now += 60_001
    await expect(
      instance.complete({
        ...binding,
        callbackUrl: `${callbackUrl}?code=idp-code&state=provider-state-3`,
      })
    ).rejects.toMatchObject({ code: "invalid-flow" })

    now = 10_000
    await instance.begin(binding)
    await expect(
      instance.complete({
        ...binding,
        principalId: "operator:8",
        callbackUrl: `${callbackUrl}?code=idp-code&state=provider-state-6`,
      })
    ).rejects.toMatchObject({ code: "invalid-flow" })
    await expect(
      instance.complete({
        ...binding,
        callbackUrl: `${callbackUrl}?code=idp-code&state=provider-state-6`,
      })
    ).rejects.toMatchObject({ code: "invalid-flow" })
  })

  it.each([
    ["lane", { lane: "guest" }],
    ["browser session", { browserSessionId: "other-browser" }],
  ])("rejects %s substitution", async (_label, replacement) => {
    const native = nativeFixture()
    const instance = broker(native.fetcher as typeof fetch)
    await instance.begin(binding)
    await expect(
      instance.complete({
        ...binding,
        ...replacement,
        callbackUrl: `${callbackUrl}?code=idp-code&state=provider-state-3`,
      })
    ).rejects.toMatchObject({ code: "invalid-flow" })
  })

  it("rejects unsafe return routes and callback substitution before native I/O", async () => {
    const native = nativeFixture()
    const instance = broker(native.fetcher as typeof fetch)

    await expect(
      instance.begin({ ...binding, returnPath: "//evil.example/steal" })
    ).rejects.toBeInstanceOf(HermesBrowserAuthenticationError)
    await expect(
      instance.begin({
        ...binding,
        callbackUrl: "https://evil.example/auth/callback",
      })
    ).rejects.toMatchObject({ code: "invalid-request" })
    await expect(
      instance.begin({ ...binding, callbackUrl: "%not-a-url" })
    ).rejects.toMatchObject({
      name: "HermesBrowserAuthenticationError",
      code: "invalid-request",
      message: "Hermes authentication failed",
    })
    expect(native.fetcher).not.toHaveBeenCalled()
  })

  it("does not reflect an unallowlisted identity redirect or mismatched callback", async () => {
    const unsafe = nativeFixture({
      authorizeOrigin: "https://evil.example.test",
    })
    await expect(
      broker(unsafe.fetcher as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "identity-origin-not-allowed",
    })

    const mismatch = nativeFixture({
      advertisedCallback: "https://hermes.example.test/auth/callback",
    })
    await expect(
      broker(mismatch.fetcher as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "callback-mismatch",
    })
  })

  it("reports absent native PKCE and password-only providers honestly", async () => {
    const oldHermes = nativeFixture({ authFlows: ["cookie"] })
    await expect(
      broker(oldHermes.fetcher as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "native-pkce-unavailable",
    })

    const password = nativeFixture({ password: true })
    await expect(
      broker(password.fetcher as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "password-provider-unsupported",
    })
  })

  it("rejects redirects, malformed JSON, and oversized native responses", async () => {
    const redirecting = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/status" },
        })
    )
    await expect(
      broker(redirecting as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "invalid-native-response",
    })
    expect(redirecting.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" })

    const malformed = vi.fn(async () => new Response("not-json"))
    await expect(
      broker(malformed as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "invalid-native-response",
    })

    const oversized = vi.fn(
      async () =>
        new Response("x".repeat(1025), {
          headers: { "content-length": "1025" },
        })
    )
    await expect(
      broker(oversized as typeof fetch, { maxResponseBytes: 1024 }).begin(
        binding
      )
    ).resolves.toEqual({
      status: "unavailable",
      reason: "invalid-native-response",
    })
  })

  it("clears server credentials when native refresh reports authentication loss", async () => {
    let now = 1_000_000
    const native = nativeFixture({ refreshStatus: 401 })
    const instance = broker(native.fetcher as typeof fetch, {
      clock: () => now,
      credentialRefreshSkewMs: 120_000,
    })
    await beginAndComplete(instance)
    now = 4_000_000_000_000 - 100_000

    await expect(
      instance.credentials({
        principalId: binding.principalId,
        lane: binding.lane,
      })
    ).rejects.toMatchObject({
      code: "session-expired",
      message: "Hermes authentication failed",
    })
    expect(
      instance.authState({
        principalId: binding.principalId,
        lane: binding.lane,
      })
    ).toEqual({ status: "authentication-required" })
  })

  it("coalesces concurrent refreshes so a rotating refresh token is used once", async () => {
    let now = 1_000_000
    const native = nativeFixture()
    const instance = broker(native.fetcher as typeof fetch, {
      clock: () => now,
      credentialRefreshSkewMs: 120_000,
    })
    await beginAndComplete(instance)
    now = 4_000_000_000_000 - 100_000

    await expect(
      Promise.all([
        instance.credentials({ principalId: "operator:7", lane: "operator" }),
        instance.credentials({ principalId: "operator:7", lane: "operator" }),
      ])
    ).resolves.toEqual([
      { authorization: "Bearer rotated-access" },
      { authorization: "Bearer rotated-access" },
    ])
    expect(
      native.calls.filter(({ url }) => url.pathname === "/auth/native/refresh")
    ).toHaveLength(1)
  })
})
