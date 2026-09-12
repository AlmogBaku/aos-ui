// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import {
  createOidcCore,
  type OidcCoreOptions,
  type OidcFetch,
  type OidcProvider,
} from "./oidc"

const issuer = "https://idp.example.test"
const redirectUri = "https://aos.example.test/api/aos/v1/auth/operator/callback"

function discoveryMetadata() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  }
}

function neverEndingJsonResponse(onCancel: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        onCancel()
      },
    }),
    { headers: { "content-type": "application/json" } }
  )
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function signIdToken(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  claims: Record<string, unknown>
): string {
  const encoded = `${base64urlJson({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${base64urlJson(claims)}`
  const signature = sign("RSA-SHA256", Buffer.from(encoded), privateKey)
  return `${encoded}.${signature.toString("base64url")}`
}

function provider(overrides: Partial<OidcProvider> = {}): OidcProvider {
  return {
    buildAuthorizationUrl(parameters) {
      const url = new URL(`${issuer}/authorize`)
      for (const [name, value] of Object.entries(parameters)) {
        url.searchParams.set(name, value)
      }
      return url
    },
    authorizationCodeGrant: vi.fn(async () => ({
      issuer,
      subject: "operator-1",
    })),
    ...overrides,
  }
}

function constructionOptions(
  overrides: Partial<OidcCoreOptions<{ id: string }>> = {}
): OidcCoreOptions<{ id: string }> {
  return {
    issuer,
    clientId: "aos-ui",
    clientSecret: "client-secret",
    redirectUri,
    publicOrigin: "https://aos.example.test",
    allowedSubjects: ["operator-1"],
    principalHmacKey: new Uint8Array(32).fill(7),
    provider: provider(),
    sessionIssuer: {
      async issue() {
        return { session: { id: "aos-session-1" }, cookie: "aos=session" }
      },
    },
    ...overrides,
  }
}

describe("OIDC core", () => {
  it("allows an exact loopback HTTP public origin for local operation", () => {
    expect(() =>
      createOidcCore(
        constructionOptions({
          publicOrigin: "http://127.0.0.1:3000",
          redirectUri:
            "http://127.0.0.1:3000/api/aos/v1/auth/operator/callback",
        })
      )
    ).not.toThrow()
  })

  it.each([
    ["insecure issuer", { issuer: "http://idp.example.test" }],
    ["issuer userinfo", { issuer: "https://user@idp.example.test" }],
    ["issuer query", { issuer: "https://idp.example.test?tenant=alpha" }],
    ["issuer fragment", { issuer: "https://idp.example.test#tenant" }],
    ["insecure public origin", { publicOrigin: "http://aos.example.test" }],
    ["public origin path", { publicOrigin: "https://aos.example.test/app" }],
    [
      "cross-origin redirect URI",
      {
        redirectUri:
          "https://evil.example.test/api/aos/v1/auth/operator/callback",
      },
    ],
    [
      "wrong redirect path",
      { redirectUri: "https://aos.example.test/api/aos/v1/auth/callback" },
    ],
    ["short HMAC key", { principalHmacKey: new Uint8Array(31).fill(7) }],
    ["empty client ID", { clientId: "" }],
    ["oversized client ID", { clientId: "c".repeat(257) }],
    ["empty client secret", { clientSecret: "" }],
    ["oversized client secret", { clientSecret: "s".repeat(16_385) }],
    ["empty subject allowlist", { allowedSubjects: [] }],
    [
      "oversized subject allowlist",
      {
        allowedSubjects: Array.from(
          { length: 257 },
          (_, index) => `operator-${index}`
        ),
      },
    ],
    ["duplicate subjects", { allowedSubjects: ["operator-1", "operator-1"] }],
    ["empty subject", { allowedSubjects: [""] }],
    ["oversized subject", { allowedSubjects: ["s".repeat(257)] }],
  ] satisfies ReadonlyArray<
    readonly [string, Partial<OidcCoreOptions<{ id: string }>>]
  >)("rejects unsafe construction input: %s", (_name, overrides) => {
    expect(() => createOidcCore(constructionOptions(overrides))).toThrow(
      "OIDC authentication failed"
    )
  })

  it("starts Authorization Code with S256 PKCE and keeps secrets server-side", async () => {
    let authorizationParameters: Record<string, string> | undefined
    const oidc = provider({
      buildAuthorizationUrl(parameters) {
        authorizationParameters = parameters
        return new URL(`${issuer}/authorize`)
      },
    })
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      provider: oidc,
      sessionIssuer: {
        issue: vi.fn(async () => ({
          session: { id: "session-1" },
          cookie: "aos=session",
        })),
      },
    })

    const started = await core.begin("/agents/alpha?tab=chat#latest")

    expect(authorizationParameters).toMatchObject({
      redirect_uri: redirectUri,
      scope: "openid",
      response_type: "code",
      code_challenge_method: "S256",
    })
    expect(authorizationParameters?.state).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(authorizationParameters?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(authorizationParameters?.code_challenge).toMatch(
      /^[A-Za-z0-9_-]{43}$/u
    )
    expect(started.authorizationUrl.href).toBe(`${issuer}/authorize`)
    expect(started.flowCookie).toMatch(
      /^__Host-aos-oidc-flow=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=300; Secure; HttpOnly; SameSite=Lax$/u
    )
    expect(started.flowCookie).not.toContain(
      authorizationParameters?.state ?? ""
    )
    expect(started.flowCookie).not.toContain("/agents/alpha")
  })

  it.each([
    "http://idp.example.test/authorize",
    "https://evil.example.test/authorize",
    "https://user@idp.example.test/authorize",
  ])(
    "rejects an authorization URL outside the trusted issuer authority: %s",
    async (authorizationUrl) => {
      const core = createOidcCore(
        constructionOptions({
          provider: provider({
            buildAuthorizationUrl() {
              return new URL(authorizationUrl)
            },
          }),
        })
      )

      await expect(core.begin("/agents/alpha")).rejects.toThrow(
        "OIDC authentication failed"
      )
    }
  )

  it("rejects an oversized authorization URL", async () => {
    const core = createOidcCore(
      constructionOptions({
        provider: provider({
          buildAuthorizationUrl() {
            return new URL(`${issuer}/authorize?padding=${"x".repeat(8_192)}`)
          },
        }),
      })
    )

    await expect(core.begin("/agents/alpha")).rejects.toThrow(
      "OIDC authentication failed"
    )
  })

  it.each([
    [
      "callback URL",
      (url: URL) => url.searchParams.set("padding", "x".repeat(8_192)),
    ],
    [
      "authorization code",
      (url: URL) => url.searchParams.set("code", "x".repeat(4_097)),
    ],
    ["state", (url: URL) => url.searchParams.set("state", "x".repeat(257))],
  ] as const)("rejects an oversized %s", async (_name, mutateCallback) => {
    let exchangeCount = 0
    const core = createOidcCore(
      constructionOptions({
        provider: provider({
          async authorizationCodeGrant() {
            exchangeCount += 1
            return { issuer, subject: "operator-1" }
          },
        }),
      })
    )
    const started = await core.begin("/agents/alpha")
    const callbackUrl = new URL(`${redirectUri}?code=authorization-code`)
    mutateCallback(callbackUrl)

    const completed = await core.complete(
      callbackUrl,
      started.flowCookie.split(";", 1)[0]!
    )

    expect(completed.status).toBe("rejected")
    expect(exchangeCount).toBe(0)
  })

  it.each([
    "agents/alpha",
    "https://evil.example.test/agents/alpha",
    "//evil.example.test/agents/alpha",
    "/\\evil.example.test/agents/alpha",
    "/agents/alpha\\redirect",
    "/%5cevil.example.test/agents/alpha",
    "/%2f%2fevil.example.test/agents/alpha",
    "/.%2e//evil.example.test/agents/alpha",
    "/%2e%2e//evil.example.test/agents/alpha",
    "/a/%2e%2e//evil.example.test/agents/alpha",
    "/agents/%0d%0aLocation:%20https://evil.example.test",
    "/agents/%zz",
  ])(
    "rejects a return route that is not a same-origin application path: %s",
    async (returnPath) => {
      const core = createOidcCore({
        issuer,
        clientId: "aos-ui",
        clientSecret: "client-secret",
        redirectUri,
        publicOrigin: "https://aos.example.test",
        allowedSubjects: ["operator-1"],
        principalHmacKey: new Uint8Array(32).fill(7),
        provider: provider(),
        sessionIssuer: {
          issue: vi.fn(async () => ({
            session: { id: "session-1" },
            cookie: "aos=session",
          })),
        },
      })

      await expect(core.begin(returnPath)).rejects.toThrow(
        "OIDC authentication failed"
      )
    }
  )

  it("consumes a callback into an opaque AOS session without returning IdP material", async () => {
    let authorizationParameters: Record<string, string> | undefined
    let grantChecks:
      | {
          expectedNonce: string
          expectedState: string
          pkceCodeVerifier: string
        }
      | undefined
    let grantUrl: URL | undefined
    let issuedPrincipal: string | undefined
    const oidc = provider({
      buildAuthorizationUrl(parameters) {
        authorizationParameters = parameters
        return new URL(`${issuer}/authorize`)
      },
      async authorizationCodeGrant(callbackUrl, checks) {
        grantUrl = callbackUrl
        grantChecks = checks
        return {
          issuer,
          subject: "operator-1",
          accessToken: "provider-access-token",
          email: "operator@example.test",
        }
      },
    })
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      provider: oidc,
      sessionIssuer: {
        async issue({ principalId }) {
          issuedPrincipal = principalId
          return {
            session: { id: "aos-session-1", expiresAt: 123_456 },
            cookie: "__Host-aos-session=opaque-session; Secure; HttpOnly",
          }
        },
      },
    })
    const started = await core.begin("/agents/alpha?tab=chat#latest")
    const callbackUrl = new URL(redirectUri)
    callbackUrl.searchParams.set("code", "authorization-code")
    callbackUrl.searchParams.set("state", authorizationParameters!.state)

    const completed = await core.complete(
      callbackUrl,
      started.flowCookie.split(";", 1)[0]
    )

    expect(grantUrl?.href).toBe(callbackUrl.href)
    expect(grantChecks).toEqual({
      expectedNonce: authorizationParameters!.nonce,
      expectedState: authorizationParameters!.state,
      pkceCodeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    })
    expect(issuedPrincipal).toBe(
      "aos_principal_RyvL4DQmMxNeS60eW0FuHwFt4pTL9a6cPolOHgzkJGA"
    )
    expect(completed).toEqual({
      status: "authenticated",
      returnPath: "/agents/alpha?tab=chat#latest",
      session: { id: "aos-session-1", expiresAt: 123_456 },
      sessionCookie: "__Host-aos-session=opaque-session; Secure; HttpOnly",
      flowCookie:
        "__Host-aos-oidc-flow=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    })
    expect(JSON.stringify(completed)).not.toMatch(
      /operator-1|operator@example|provider-access-token|idp\.example/u
    )
  })

  it.each(["operator-2", "Operator-1", "operator-1 "])(
    "denies a subject that is not an exact allowlist member: %s",
    async (subject) => {
      let sessionIssueCount = 0
      const core = createOidcCore({
        issuer,
        clientId: "aos-ui",
        clientSecret: "client-secret",
        redirectUri,
        publicOrigin: "https://aos.example.test",
        allowedSubjects: ["operator-1"],
        principalHmacKey: new Uint8Array(32).fill(7),
        provider: provider({
          async authorizationCodeGrant() {
            return { issuer, subject }
          },
        }),
        sessionIssuer: {
          async issue() {
            sessionIssueCount += 1
            return {
              session: { id: "must-not-exist" },
              cookie: "must-not-exist",
            }
          },
        },
      })
      const started = await core.begin("/agents/alpha")

      const completed = await core.complete(
        new URL(`${redirectUri}?code=authorization-code`),
        started.flowCookie.split(";", 1)[0]
      )

      expect(completed).toEqual({
        status: "rejected",
        flowCookie:
          "__Host-aos-oidc-flow=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
      })
      expect(sessionIssueCount).toBe(0)
    }
  )

  it("rejects an identity whose verified issuer is not the configured issuer", async () => {
    let sessionIssueCount = 0
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      provider: provider({
        async authorizationCodeGrant() {
          return {
            issuer: "https://other-idp.example.test",
            subject: "operator-1",
          }
        },
      }),
      sessionIssuer: {
        async issue() {
          sessionIssueCount += 1
          return { session: { id: "must-not-exist" }, cookie: "must-not-exist" }
        },
      },
    })
    const started = await core.begin("/agents/alpha")

    const completed = await core.complete(
      new URL(`${redirectUri}?code=authorization-code`),
      started.flowCookie.split(";", 1)[0]
    )

    expect(completed.status).toBe("rejected")
    expect(sessionIssueCount).toBe(0)
  })

  it("atomically consumes a flow before awaiting the token exchange", async () => {
    let exchangeCount = 0
    let releaseExchange!: () => void
    const exchangeReleased = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      provider: provider({
        async authorizationCodeGrant() {
          exchangeCount += 1
          await exchangeReleased
          return { issuer, subject: "operator-1" }
        },
      }),
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })
    const started = await core.begin("/agents/alpha")
    const cookieHeader = started.flowCookie.split(";", 1)[0]
    const callbackUrl = new URL(`${redirectUri}?code=authorization-code`)

    const firstPromise = core.complete(callbackUrl, cookieHeader)
    const replayPromise = core.complete(callbackUrl, cookieHeader)
    await Promise.resolve()
    const countBeforeRelease = exchangeCount
    releaseExchange()
    const [first, replay] = await Promise.all([firstPromise, replayPromise])

    expect(countBeforeRelease).toBe(1)
    expect(replay.status).toBe("rejected")
    expect(first.status).toBe("authenticated")
  })

  it("accepts a flow before five minutes and expires it at the TTL boundary", async () => {
    let now = 1_000
    let exchangeCount = 0
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      now: () => now,
      provider: provider({
        async authorizationCodeGrant() {
          exchangeCount += 1
          return { issuer, subject: "operator-1" }
        },
      }),
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })

    const fresh = await core.begin("/agents/fresh")
    now = 300_999
    const freshResult = await core.complete(
      new URL(`${redirectUri}?code=fresh`),
      fresh.flowCookie.split(";", 1)[0]
    )
    now = 400_000
    const expired = await core.begin("/agents/expired")
    now = 700_000
    const expiredResult = await core.complete(
      new URL(`${redirectUri}?code=expired`),
      expired.flowCookie.split(";", 1)[0]
    )

    expect(freshResult.status).toBe("authenticated")
    expect(expiredResult.status).toBe("rejected")
    expect(exchangeCount).toBe(1)
  })

  it("bounds active pending flows at 256", async () => {
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      provider: provider(),
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })

    for (let index = 0; index < 256; index += 1) {
      await core.begin(`/agents/${index}`)
    }

    await expect(core.begin("/agents/overflow")).rejects.toThrow(
      "OIDC authentication failed"
    )
  })

  it("keeps the 256-flow bound under concurrent starts", async () => {
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      provider: provider(),
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })

    const starts = await Promise.allSettled(
      Array.from({ length: 257 }, (_, index) => core.begin(`/agents/${index}`))
    )

    expect(
      starts.filter((result) => result.status === "fulfilled")
    ).toHaveLength(256)
    expect(
      starts.filter((result) => result.status === "rejected")
    ).toHaveLength(1)
  })

  it("rejects the 257th start before a blocked discovery reaches upstream", async () => {
    let releaseDiscovery!: (response: Response) => void
    const blockedDiscovery = new Promise<Response>((resolve) => {
      releaseDiscovery = resolve
    })
    let discoveryRequests = 0
    const core = createOidcCore({
      ...constructionOptions(),
      provider: undefined,
      fetcher: async () => {
        discoveryRequests += 1
        return blockedDiscovery
      },
    })

    const starts = Array.from({ length: 257 }, (_, index) =>
      core.begin(`/agents/${index}`)
    )
    let overflowBeforeDiscovery: "fulfilled" | "pending" | "rejected" =
      "pending"
    void starts[256]!.then(
      () => {
        overflowBeforeDiscovery = "fulfilled"
      },
      () => {
        overflowBeforeDiscovery = "rejected"
      }
    )
    await Promise.resolve()
    await Promise.resolve()

    releaseDiscovery(
      Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      })
    )
    const settled = await Promise.allSettled(starts)

    expect(overflowBeforeDiscovery).toBe("rejected")
    expect(discoveryRequests).toBe(1)
    expect(
      settled.filter((result) => result.status === "fulfilled")
    ).toHaveLength(256)
  })

  it.each(["token exchange", "session issuance"] as const)(
    "retains flow admission until %s finishes",
    async (blockedPhase) => {
      let releaseCompletion!: () => void
      const completionBarrier = new Promise<void>((resolve) => {
        releaseCompletion = resolve
      })
      let completionPhaseEntered = false
      let authorizationRequests = 0
      const oidc = provider({
        buildAuthorizationUrl(parameters) {
          authorizationRequests += 1
          const url = new URL(`${issuer}/authorize`)
          for (const [name, value] of Object.entries(parameters)) {
            url.searchParams.set(name, value)
          }
          return url
        },
        async authorizationCodeGrant() {
          if (blockedPhase === "token exchange") {
            completionPhaseEntered = true
            await completionBarrier
          }
          return { issuer, subject: "operator-1" }
        },
      })
      const core = createOidcCore(
        constructionOptions({
          provider: oidc,
          sessionIssuer: {
            async issue() {
              if (blockedPhase === "session issuance") {
                completionPhaseEntered = true
                await completionBarrier
              }
              return { session: { id: "aos-session-1" }, cookie: "aos=session" }
            },
          },
        })
      )
      const starts = await Promise.all(
        Array.from({ length: 256 }, (_, index) =>
          core.begin(`/agents/${index}`)
        )
      )
      const completing = core.complete(
        new URL(`${redirectUri}?code=authorization-code`),
        starts[0]!.flowCookie.split(";", 1)[0]!
      )
      for (let turn = 0; turn < 5 && !completionPhaseEntered; turn += 1) {
        await Promise.resolve()
      }

      const overflow = await core.begin("/agents/overflow").then(
        () => "fulfilled" as const,
        () => "rejected" as const
      )
      const enteredBeforeRelease = completionPhaseEntered
      releaseCompletion()
      await completing

      expect(enteredBeforeRelease).toBe(true)
      expect(overflow).toBe("rejected")
      expect(authorizationRequests).toBe(256)
    }
  )

  it("does not retain a pending flow when authorization URL creation fails", async () => {
    let attempts = 0
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      provider: provider({
        buildAuthorizationUrl() {
          attempts += 1
          if (attempts <= 256) throw new Error("provider secret diagnostic")
          return new URL(`${issuer}/authorize`)
        },
      }),
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })
    for (let index = 0; index < 256; index += 1) {
      await expect(core.begin(`/agents/${index}`)).rejects.toThrow(
        "OIDC authentication failed"
      )
    }

    await expect(core.begin("/agents/retry")).resolves.toHaveProperty(
      "authorizationUrl"
    )
  })

  it("prunes expired flows before enforcing the pending-flow bound", async () => {
    let now = 0
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      now: () => now,
      provider: provider(),
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })
    for (let index = 0; index < 256; index += 1) {
      await core.begin(`/agents/${index}`)
    }

    now = 300_000

    await expect(core.begin("/agents/replacement")).resolves.toHaveProperty(
      "authorizationUrl"
    )
  })

  it("rejects and consumes a callback outside the configured redirect URI", async () => {
    let exchangeCount = 0
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      provider: provider({
        async authorizationCodeGrant() {
          exchangeCount += 1
          return { issuer, subject: "operator-1" }
        },
      }),
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })
    const started = await core.begin("/agents/alpha")
    const cookieHeader = started.flowCookie.split(";", 1)[0]

    const wrongOrigin = await core.complete(
      new URL("https://evil.example.test/callback?code=authorization-code"),
      cookieHeader
    )
    const replay = await core.complete(
      new URL(`${redirectUri}?code=authorization-code`),
      cookieHeader
    )

    expect(wrongOrigin.status).toBe("rejected")
    expect(replay.status).toBe("rejected")
    expect(exchangeCount).toBe(0)
  })

  it("uses bounded discovery and normalizes provider diagnostics", async () => {
    let discoverySignal: AbortSignal | null | undefined
    let requestedUrl: string | undefined
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      networkTimeoutMs: 1_234,
      fetcher: async (input, init) => {
        requestedUrl = String(input)
        discoverySignal = init?.signal
        throw new Error(
          "provider diagnostic: subject operator-1 access-token secret"
        )
      },
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })

    let rejected: unknown
    try {
      await core.begin("/agents/alpha")
    } catch (error) {
      rejected = error
    }

    expect(requestedUrl).toBe(
      "https://idp.example.test/.well-known/openid-configuration"
    )
    expect(discoverySignal).toBeInstanceOf(AbortSignal)
    expect(discoverySignal?.aborted).toBe(false)
    expect(rejected).toMatchObject({
      name: "OidcAuthenticationError",
      message: "OIDC authentication failed",
    })
    expect(JSON.stringify(rejected)).not.toMatch(
      /operator-1|access-token|provider diagnostic/u
    )
  })

  it("rejects a discovery body whose declared length exceeds the bound", async () => {
    let cancellationCount = 0
    const body = JSON.stringify(discoveryMetadata())
    const core = createOidcCore({
      ...constructionOptions(),
      provider: undefined,
      fetcher: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body))
              controller.close()
            },
            cancel() {
              cancellationCount += 1
            },
          }),
          {
            headers: {
              "content-length": "1048577",
              "content-type": "application/json",
            },
          }
        ),
    })

    await expect(core.begin("/agents/alpha")).rejects.toThrow(
      "OIDC authentication failed"
    )
    expect(cancellationCount).toBe(1)
  })

  it("rejects a chunked discovery body after it crosses the bound", async () => {
    let cancellationCount = 0
    const core = createOidcCore({
      ...constructionOptions(),
      provider: undefined,
      fetcher: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(" ".repeat(1_048_577))
              )
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(discoveryMetadata()))
              )
              controller.close()
            },
            cancel() {
              cancellationCount += 1
            },
          }),
          { headers: { "content-type": "application/json" } }
        ),
    })

    await expect(core.begin("/agents/alpha")).rejects.toThrow(
      "OIDC authentication failed"
    )
    expect(cancellationCount).toBe(1)
  })

  it("cancels a never-ending discovery body at the request deadline", async () => {
    let cancellationCount = 0
    const core = createOidcCore({
      ...constructionOptions(),
      provider: undefined,
      networkTimeoutMs: 20,
      fetcher: async () =>
        neverEndingJsonResponse(() => {
          cancellationCount += 1
        }),
    })

    const outcome = await Promise.race([
      core.begin("/agents/alpha").then(
        () => "fulfilled" as const,
        () => "rejected" as const
      ),
      new Promise<"hung">((resolve) => {
        setTimeout(() => resolve("hung"), 150)
      }),
    ])

    expect(outcome).toBe("rejected")
    expect(cancellationCount).toBe(1)
  })

  it.each(["token", "jwks"] as const)(
    "cancels a never-ending %s body at the request deadline",
    async (blockedEndpoint) => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      })
      const jwk = publicKey.export({ format: "jwk" })
      let idToken = ""
      let cancellationCount = 0
      const fetcher: OidcFetch = async (input) => {
        const url = String(input)
        if (url.endsWith("/.well-known/openid-configuration")) {
          return Response.json(discoveryMetadata())
        }
        if (url === `${issuer}/token`) {
          if (blockedEndpoint === "token") {
            return neverEndingJsonResponse(() => {
              cancellationCount += 1
            })
          }
          return Response.json({
            access_token: "provider-access-token",
            token_type: "Bearer",
            expires_in: 300,
            id_token: idToken,
          })
        }
        if (url === `${issuer}/jwks`) {
          if (blockedEndpoint === "jwks") {
            return neverEndingJsonResponse(() => {
              cancellationCount += 1
            })
          }
          return Response.json({
            keys: [{ ...jwk, kid: "test-key", use: "sig" }],
          })
        }
        throw new Error(`Unexpected synthetic IdP URL: ${url}`)
      }
      const core = createOidcCore({
        ...constructionOptions(),
        provider: undefined,
        networkTimeoutMs: 20,
        fetcher,
      })
      const started = await core.begin("/agents/alpha")
      const state = started.authorizationUrl.searchParams.get("state")!
      const nonce = started.authorizationUrl.searchParams.get("nonce")!
      const currentSeconds = Math.floor(Date.now() / 1_000)
      idToken = signIdToken(privateKey, {
        iss: issuer,
        sub: "operator-1",
        aud: "aos-ui",
        iat: currentSeconds,
        exp: currentSeconds + 300,
        nonce,
      })
      const callbackUrl = new URL(redirectUri)
      callbackUrl.searchParams.set("code", "authorization-code")
      callbackUrl.searchParams.set("state", state)

      const outcome = await Promise.race([
        core
          .complete(callbackUrl, started.flowCookie.split(";", 1)[0]!)
          .then((completion) => completion.status),
        new Promise<"hung">((resolve) => {
          setTimeout(() => resolve("hung"), 150)
        }),
      ])

      expect(outcome).toBe("rejected")
      expect(cancellationCount).toBe(1)
    }
  )

  it("allows a later discovery attempt after a transient failure", async () => {
    let discoveryAttempts = 0
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      fetcher: async () => {
        discoveryAttempts += 1
        if (discoveryAttempts === 1) throw new Error("transient secret error")
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        })
      },
      sessionIssuer: {
        async issue() {
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })

    await expect(core.begin("/agents/first")).rejects.toThrow(
      "OIDC authentication failed"
    )
    await expect(core.begin("/agents/retry")).resolves.toHaveProperty(
      "authorizationUrl"
    )
    expect(discoveryAttempts).toBe(2)
  })

  it("delegates discovery and ID-token security checks to openid-client", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    const jwk = publicKey.export({ format: "jwk" })
    let idToken = ""
    let tokenRequestBody = ""
    let tokenRequestSignal: AbortSignal | null | undefined
    let jwksRequestSignal: AbortSignal | null | undefined
    const fetcher: OidcFetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        })
      }
      if (url === `${issuer}/token`) {
        tokenRequestBody = String(init?.body)
        tokenRequestSignal = init?.signal
        return Response.json({
          access_token: "provider-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        })
      }
      if (url === `${issuer}/jwks`) {
        jwksRequestSignal = init?.signal
        return Response.json({
          keys: [{ ...jwk, kid: "test-key", use: "sig" }],
        })
      }
      throw new Error(`Unexpected synthetic IdP URL: ${url}`)
    }
    let issuedPrincipal = ""
    let sessionIssueCount = 0
    const core = createOidcCore({
      issuer,
      clientId: "aos-ui",
      clientSecret: "client-secret",
      redirectUri,
      publicOrigin: "https://aos.example.test",
      allowedSubjects: ["operator-1"],
      principalHmacKey: new Uint8Array(32).fill(7),
      fetcher,
      sessionIssuer: {
        async issue({ principalId }) {
          sessionIssueCount += 1
          issuedPrincipal = principalId
          return { session: { id: "aos-session-1" }, cookie: "aos=session" }
        },
      },
    })
    async function completeWithIdToken(
      claimOverrides: Record<string, unknown> = {},
      signingKey = privateKey,
      callbackState?: string
    ) {
      const started = await core.begin("/agents/alpha")
      const state = started.authorizationUrl.searchParams.get("state")!
      const nonce = started.authorizationUrl.searchParams.get("nonce")!
      const currentSeconds = Math.floor(Date.now() / 1_000)
      idToken = signIdToken(signingKey, {
        iss: issuer,
        sub: "operator-1",
        aud: "aos-ui",
        iat: currentSeconds,
        exp: currentSeconds + 300,
        nonce,
        ...claimOverrides,
      })
      const callbackUrl = new URL(redirectUri)
      callbackUrl.searchParams.set("code", "authorization-code")
      callbackUrl.searchParams.set("state", callbackState ?? state)
      return core.complete(callbackUrl, started.flowCookie.split(";", 1)[0])
    }

    const completed = await completeWithIdToken()
    const wrongNonce = await completeWithIdToken({ nonce: "wrong-nonce" })
    const wrongAudience = await completeWithIdToken({ aud: "other-client" })
    const wrongAuthorizedParty = await completeWithIdToken({
      azp: "other-client",
    })
    const matchingAuthorizedParty = await completeWithIdToken({ azp: "aos-ui" })
    const matchingAuthorizedPartyForMultipleAudiences =
      await completeWithIdToken({
        aud: ["aos-ui", "other-client"],
        azp: "aos-ui",
      })
    const rogueKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey
    const wrongSignature = await completeWithIdToken({}, rogueKey)
    const wrongState = await completeWithIdToken({}, privateKey, "wrong-state")

    expect(completed.status).toBe("authenticated")
    expect(wrongNonce.status).toBe("rejected")
    expect(wrongAudience.status).toBe("rejected")
    expect(wrongAuthorizedParty.status).toBe("rejected")
    expect(matchingAuthorizedParty.status).toBe("authenticated")
    expect(matchingAuthorizedPartyForMultipleAudiences.status).toBe(
      "authenticated"
    )
    expect(wrongSignature.status).toBe("rejected")
    expect(wrongState.status).toBe("rejected")
    expect(sessionIssueCount).toBe(3)
    expect(issuedPrincipal).toBe(
      "aos_principal_RyvL4DQmMxNeS60eW0FuHwFt4pTL9a6cPolOHgzkJGA"
    )
    expect(new URLSearchParams(tokenRequestBody).get("code_verifier")).toMatch(
      /^[A-Za-z0-9_-]{43}$/u
    )
    expect(tokenRequestSignal).toBeInstanceOf(AbortSignal)
    expect(jwksRequestSignal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(completed)).not.toContain("provider-access-token")
  })
})
