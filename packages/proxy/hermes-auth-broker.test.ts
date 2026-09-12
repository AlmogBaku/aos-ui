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
  refreshToken?: string
  expiresAt?: number
  authorizeCookies?: readonly string[]
  expectedCookieHeader?: string
  nativeResultExtra?: Readonly<Record<string, string>>
  tokenAccessTokens?: readonly string[]
  tokenExpiresAt?: readonly number[]
  refreshResponse?: () => Promise<Response>
  authorizeGate?: Promise<void>
}

function nativeFixture(options: NativeFixtureOptions = {}) {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  let nativeRedirect = ""
  let clientState = ""
  let tokenIndex = 0
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
        await options.authorizeGate
        nativeRedirect = url.searchParams.get("redirect_uri") ?? ""
        clientState = url.searchParams.get("state") ?? ""
        const headers = new Headers(init?.headers)
        const forwardedHost = headers.get("host") ?? url.host
        const forwardedProto = headers.get("x-forwarded-proto") ?? url.protocol
        const forwardedPrefix = headers.get("x-forwarded-prefix") ?? ""
        const actualCallback = `${forwardedProto.replace(/:$/u, "")}://${forwardedHost}${forwardedPrefix}/auth/callback`
        const authorize = new URL(
          "/oauth/authorize",
          options.authorizeOrigin ?? identityOrigin
        )
        authorize.searchParams.set("state", `provider-state-${calls.length}`)
        authorize.searchParams.set(
          "redirect_uri",
          options.advertisedCallback ?? actualCallback
        )
        const responseHeaders = new Headers({ location: authorize.toString() })
        for (const cookie of options.authorizeCookies ?? [
          "hermes_session_pkce=server-only; Path=/; Secure; HttpOnly",
        ])
          responseHeaders.append("set-cookie", cookie)
        return new Response(null, { status: 302, headers: responseHeaders })
      }
      if (url.pathname === "/auth/callback") {
        const cookie = new Headers(init?.headers).get("cookie")
        expect(cookie).toBe(
          options.expectedCookieHeader ?? "hermes_session_pkce=server-only"
        )
        const target = new URL(nativeRedirect)
        target.searchParams.set("code", "gateway-code")
        target.searchParams.set("state", clientState)
        for (const [key, value] of Object.entries(
          options.nativeResultExtra ?? {}
        ))
          target.searchParams.set(key, value)
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
        const currentToken = tokenIndex++
        return Response.json({
          access_token:
            options.tokenAccessTokens?.[currentToken] ?? "secret-access",
          refresh_token: options.refreshToken ?? "secret-refresh",
          token_type: "Bearer",
          expires_at:
            options.tokenExpiresAt?.[currentToken] ??
            options.expiresAt ??
            4_000_000_000,
          provider: "nous",
          user_id: "native-user",
        })
      }
      if (url.pathname === "/auth/native/refresh") {
        if (options.refreshResponse) return options.refreshResponse()
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
  expectedState?: string
) {
  const started = await instance.begin(binding)
  expect(started.status).toBe("redirect")
  if (started.status !== "redirect") throw new Error("expected redirect")
  const state =
    expectedState ??
    new URL(started.response.headers.get("location") ?? "").searchParams.get(
      "state"
    )
  if (!state) throw new Error("expected provider state")
  return instance.complete({
    ...binding,
    callbackUrl: `${callbackUrl}?code=idp-code&state=${state}`,
  })
}

describe("Hermes external-browser authentication broker", () => {
  it("allows the fixed provider-neutral callback on a literal loopback HTTP origin", () => {
    const native = nativeFixture()
    expect(() =>
      broker(native.fetcher as typeof fetch, {
        publicOrigin: "http://127.0.0.1:3000",
        callbackUrl:
          "http://127.0.0.1:3000/api/aos/v1/auth/runtime/upstream/auth/callback",
      })
    ).not.toThrow()
  })

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
    expect(new Headers(authorize?.init?.headers).get("host")).toBe(
      "aos.example.test"
    )
    expect(
      new Headers(authorize?.init?.headers).get("x-forwarded-prefix")
    ).toBe("/api/aos/v1/auth/hermes/upstream")
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

  it("admits at most the configured number of concurrent browser flows", async () => {
    let releaseAuthorize: (() => void) | undefined
    const authorizeGate = new Promise<void>((resolve) => {
      releaseAuthorize = resolve
    })
    const native = nativeFixture({ authorizeGate })
    const instance = broker(native.fetcher as typeof fetch, { maxFlows: 1 })

    const first = instance.begin(binding)
    await vi.waitFor(() =>
      expect(
        native.calls.filter(
          ({ url }) => url.pathname === "/auth/native/authorize"
        )
      ).toHaveLength(1)
    )
    const second = instance.begin({
      ...binding,
      browserSessionId: "browser-session-2",
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseAuthorize?.()
    const results = await Promise.all([first, second])

    expect(
      native.calls.filter(
        ({ url }) => url.pathname === "/auth/native/authorize"
      )
    ).toHaveLength(1)
    expect(results.map(({ status }) => status).sort()).toEqual([
      "redirect",
      "unavailable",
    ])
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

  it.each([
    "/%2f%2fevil.example/steal",
    "/%252f%252fevil.example/steal",
    "/%5cevil",
    "/%00control",
    "/ok?next=%0dheader",
    "/%ZZmalformed",
  ])("rejects encoded or malformed return route %s", async (returnPath) => {
    const native = nativeFixture()
    await expect(
      broker(native.fetcher as typeof fetch).begin({ ...binding, returnPath })
    ).rejects.toMatchObject({
      name: "HermesBrowserAuthenticationError",
      code: "invalid-request",
    })
    expect(native.fetcher).not.toHaveBeenCalled()
  })

  it("does not admit guest lanes to operator browser authentication", async () => {
    const native = nativeFixture()
    await expect(
      broker(native.fetcher as typeof fetch).begin({
        ...binding,
        lane: "guest",
      })
    ).rejects.toMatchObject({ code: "invalid-request" })
    expect(native.fetcher).not.toHaveBeenCalled()
  })

  it("rejects return routes nested beyond the decoding bound", async () => {
    let encoded = "//evil.example/steal"
    for (let depth = 0; depth < 10; depth += 1)
      encoded = encodeURIComponent(encoded)
    const native = nativeFixture()
    await expect(
      broker(native.fetcher as typeof fetch).begin({
        ...binding,
        returnPath: `/${encoded}`,
      })
    ).rejects.toMatchObject({ code: "invalid-request" })
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

  it("applies browser cookie Domain, Path, Secure, expiry, and ordering rules", async () => {
    const native = nativeFixture({
      authorizeCookies: [
        "root=root-value; Path=/; Secure; HttpOnly",
        "specific=specific-value; Path=/api/aos/v1/auth/hermes/upstream; Secure; HttpOnly",
        "expired=bad; Path=/; Max-Age=-1; Secure",
        "wrong_path=bad; Path=/unrelated; Secure",
      ],
      expectedCookieHeader: "specific=specific-value; root=root-value",
    })
    await expect(
      beginAndComplete(broker(native.fetcher as typeof fetch))
    ).resolves.toEqual({
      status: "authenticated",
      returnPath: binding.returnPath,
    })
  })

  it("rejects cross-domain, excessive-count, and excessive-size cookie jars", async () => {
    const crossDomain = nativeFixture({
      authorizeCookies: [
        "hermes_session_pkce=bad; Domain=evil.example.test; Path=/; Secure",
      ],
    })
    await expect(
      broker(crossDomain.fetcher as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "invalid-native-response",
    })

    const excessiveCount = nativeFixture({
      authorizeCookies: Array.from(
        { length: 33 },
        (_, index) => `cookie_${index}=value; Path=/; Secure`
      ),
    })
    await expect(
      broker(excessiveCount.fetcher as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "invalid-native-response",
    })

    const excessiveSize = nativeFixture({
      authorizeCookies: Array.from(
        { length: 10 },
        (_, index) => `cookie_${index}=${"x".repeat(2_000)}; Path=/; Secure`
      ),
    })
    await expect(
      broker(excessiveSize.fetcher as typeof fetch).begin(binding)
    ).resolves.toEqual({
      status: "unavailable",
      reason: "invalid-native-response",
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

  it("rejects native loopback results containing fields beyond code and state", async () => {
    const native = nativeFixture({ nativeResultExtra: { unexpected: "value" } })
    const instance = broker(native.fetcher as typeof fetch)
    await expect(beginAndComplete(instance)).rejects.toMatchObject({
      code: "invalid-flow",
      message: "Hermes authentication failed",
    })
    expect(
      native.calls.filter(({ url }) => url.pathname === "/auth/native/token")
    ).toHaveLength(0)
  })

  it("cancels unread redirect and declared-oversized native bodies", async () => {
    let redirectCancelled = false
    const redirecting = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              redirectCancelled = true
            },
          }),
          { status: 302, headers: { location: "https://evil.example/status" } }
        )
    )
    await broker(redirecting as typeof fetch).begin(binding)
    expect(redirectCancelled).toBe(true)

    let oversizedCancelled = false
    const oversized = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              oversizedCancelled = true
            },
          }),
          { headers: { "content-length": "1025" } }
        )
    )
    await broker(oversized as typeof fetch, { maxResponseBytes: 1024 }).begin(
      binding
    )
    expect(oversizedCancelled).toBe(true)
  })

  it("does not let a stalled body cancellation extend the native timeout", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => new Promise<void>(() => undefined),
          }),
          { status: 302, headers: { location: "https://evil.example/status" } }
        )
    )
    const completion = broker(fetcher as typeof fetch, {
      timeoutMs: 100,
    }).begin(binding)
    const marker = Symbol("still-pending")
    const result = await Promise.race([
      completion,
      new Promise<typeof marker>((resolve) =>
        setTimeout(() => resolve(marker), 250)
      ),
    ])
    expect(result).not.toBe(marker)
  })

  it("keeps the native timeout active while a response body is read", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller
              init?.signal?.addEventListener("abort", () =>
                controller.error(new Error("aborted"))
              )
            },
          })
        )
    )
    const instance = broker(fetcher as typeof fetch, { timeoutMs: 100 })
    const pending = instance.begin(binding)
    const marker = Symbol("still-pending")
    const result = await Promise.race([
      pending,
      new Promise<typeof marker>((resolve) =>
        setTimeout(() => resolve(marker), 250)
      ),
    ])
    if (result === marker) bodyController?.error(new Error("test cleanup"))
    expect(result).toEqual({
      status: "unavailable",
      reason: "provider-temporarily-unavailable",
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

  it("uses a non-refreshable access token until expiry, then requires login", async () => {
    let now = 1_000_000
    const native = nativeFixture({ refreshToken: "", expiresAt: 1_100 })
    const instance = broker(native.fetcher as typeof fetch, {
      clock: () => now,
      credentialRefreshSkewMs: 120_000,
    })
    await beginAndComplete(instance)

    await expect(
      instance.credentials({ principalId: "operator:7", lane: "operator" })
    ).resolves.toEqual({ authorization: "Bearer secret-access" })
    now = 1_100_001
    await expect(
      instance.credentials({ principalId: "operator:7", lane: "operator" })
    ).rejects.toMatchObject({ code: "session-expired" })
    expect(
      native.calls.filter(({ url }) => url.pathname === "/auth/native/refresh")
    ).toHaveLength(0)
    expect(
      instance.authState({ principalId: "operator:7", lane: "operator" })
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

  it("lets the transport invalidate authentication and logout pending flows", async () => {
    const native = nativeFixture()
    const instance = broker(native.fetcher as typeof fetch)
    await beginAndComplete(instance)
    const scope = { principalId: "operator:7", lane: "operator" }

    instance.invalidate(scope)
    expect(instance.authState(scope)).toEqual({
      status: "authentication-required",
    })
    await expect(instance.credentials(scope)).rejects.toMatchObject({
      code: "session-expired",
    })

    const started = await instance.begin(binding)
    expect(started.status).toBe("redirect")
    if (started.status !== "redirect") throw new Error("expected redirect")
    const state = new URL(
      started.response.headers.get("location") ?? ""
    ).searchParams.get("state")
    instance.logout(scope)
    await expect(
      instance.complete({
        ...binding,
        callbackUrl: `${callbackUrl}?code=idp-code&state=${state}`,
      })
    ).rejects.toMatchObject({ code: "invalid-flow" })
  })

  it("does not let a stale refresh overwrite a newer browser login", async () => {
    let now = 1_000_000
    let resolveRefresh: ((response: Response) => void) | undefined
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })
    const native = nativeFixture({
      tokenAccessTokens: ["old-access", "fresh-access"],
      tokenExpiresAt: [1_100, 4_000_000_000],
      refreshResponse: () => refreshResponse,
    })
    const instance = broker(native.fetcher as typeof fetch, {
      clock: () => now,
      credentialRefreshSkewMs: 120_000,
    })
    const scope = { principalId: "operator:7", lane: "operator" }
    await beginAndComplete(instance)

    const staleRefresh = instance.credentials(scope)
    await vi.waitFor(() =>
      expect(
        native.calls.filter(
          ({ url }) => url.pathname === "/auth/native/refresh"
        )
      ).toHaveLength(1)
    )
    await beginAndComplete(instance)
    resolveRefresh?.(
      Response.json({
        access_token: "stale-rotated-access",
        refresh_token: "stale-rotated-refresh",
        token_type: "Bearer",
        expires_at: 4_000_000_000,
        provider: "nous",
        user_id: "native-user",
      })
    )

    await expect(staleRefresh).resolves.toEqual({
      authorization: "Bearer fresh-access",
    })
    now += 1
    await expect(instance.credentials(scope)).resolves.toEqual({
      authorization: "Bearer fresh-access",
    })
  })
})
