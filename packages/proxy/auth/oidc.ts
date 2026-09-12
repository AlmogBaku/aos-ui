import { createHmac } from "node:crypto"
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type CustomFetch,
} from "openid-client"

export type OidcProvider = {
  buildAuthorizationUrl(parameters: Record<string, string>): URL
  authorizationCodeGrant(
    callbackUrl: URL,
    checks: {
      expectedNonce: string
      expectedState: string
      pkceCodeVerifier: string
    }
  ): Promise<{ issuer: string; subject: string }>
}

export type AosSessionIssue<Session> = {
  session: Session
  cookie: string
}

export type AosSessionIssuer<Session> = {
  issue(input: { principalId: string }): Promise<AosSessionIssue<Session>>
}

export type OidcFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

export type OidcCoreOptions<Session> = {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  publicOrigin: string
  allowedSubjects: readonly string[]
  principalHmacKey: Uint8Array
  sessionIssuer: AosSessionIssuer<Session>
  provider?: OidcProvider
  now?: () => number
  fetcher?: OidcFetch
  networkTimeoutMs?: number
}

export type OidcStart = {
  authorizationUrl: URL
  flowCookie: string
}

export type OidcCompletion<Session> =
  | {
      status: "authenticated"
      returnPath: string
      session: Session
      sessionCookie: string
      flowCookie: string
    }
  | { status: "rejected"; flowCookie: string }

export type OidcCore<Session> = {
  begin(returnPath: string): Promise<OidcStart>
  complete(
    callbackUrl: URL,
    cookieHeader: string | null
  ): Promise<OidcCompletion<Session>>
}

type PendingFlow = {
  codeVerifier: string
  expiresAt: number
  nonce: string
  returnPath: string
  state: string
}

const flowCookieName = "__Host-aos-oidc-flow"
const callbackPath = "/api/aos/v1/auth/operator/callback"
const maxAuthorizationUrlLength = 8_192
const maxCallbackUrlLength = 8_192
const maxAuthorizationCodeLength = 4_096
const maxStateLength = 256
const maxProviderResponseBodyBytes = 1_048_576

function clearFlowCookie(): string {
  return `${flowCookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
}

function flowIdFromCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader || cookieHeader.length > 8_192) return undefined
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${flowCookieName}=`))
    .map((part) => part.slice(flowCookieName.length + 1))
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(values[0])) {
    return undefined
  }
  return values[0]
}

function principalId(key: Uint8Array, issuer: string, subject: string): string {
  const digest = createHmac("sha256", key)
    .update("aos.operator-principal.v1\0")
    .update(issuer)
    .update("\0")
    .update(subject)
    .digest("base64url")
  return `aos_principal_${digest}`
}

function isConfiguredCallback(callbackUrl: URL, redirectUri: string): boolean {
  try {
    const configured = new URL(redirectUri)
    const codes = callbackUrl.searchParams.getAll("code")
    const states = callbackUrl.searchParams.getAll("state")
    return (
      callbackUrl.href.length <= maxCallbackUrlLength &&
      callbackUrl.origin === configured.origin &&
      callbackUrl.pathname === configured.pathname &&
      callbackUrl.hash === "" &&
      codes.length <= 1 &&
      states.length <= 1 &&
      codes.every(
        (code) =>
          code.length <= maxAuthorizationCodeLength &&
          !hasControlCharacters(code)
      ) &&
      states.every(
        (state) =>
          state.length <= maxStateLength && !hasControlCharacters(state)
      )
    )
  } catch {
    return false
  }
}

function isTrustedAuthorizationUrl(url: URL, issuer: string): boolean {
  const issuerUrl = new URL(issuer)
  return (
    url.href.length <= maxAuthorizationUrlLength &&
    url.protocol === "https:" &&
    url.origin === issuerUrl.origin &&
    !url.username &&
    !url.password &&
    !url.hash
  )
}

export class OidcAuthenticationError extends Error {
  constructor() {
    super("OIDC authentication failed")
    this.name = "OidcAuthenticationError"
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function applicationPath(value: string, publicOrigin: string): string {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacters(value) ||
    /%(?![0-9a-f]{2})/iu.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|25|2f|5c|7f)/iu.test(value)
  ) {
    throw new OidcAuthenticationError()
  }
  try {
    decodeURIComponent(value)
    const origin = new URL(publicOrigin)
    const route = new URL(value, origin)
    if (
      route.origin !== origin.origin ||
      !route.pathname.startsWith("/") ||
      route.pathname.startsWith("//") ||
      route.pathname.includes("\\") ||
      hasControlCharacters(route.pathname)
    ) {
      throw new OidcAuthenticationError()
    }
    return `${route.pathname}${route.search}${route.hash}`
  } catch {
    throw new OidcAuthenticationError()
  }
}

function networkTimeout(value: number | undefined): number {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 1 || value > 30_000)
  ) {
    throw new OidcAuthenticationError()
  }
  return value ?? 5_000
}

function exactHttpsUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return undefined
  }
  try {
    const url = new URL(value)
    const exactValue = url.pathname === "/" ? url.origin : url.href
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (value !== exactValue && value !== `${url.origin}/`)
    ) {
      return undefined
    }
    return url
  } catch {
    return undefined
  }
}

function validateOptions<Session>(options: OidcCoreOptions<Session>): void {
  const issuer = exactHttpsUrl(options.issuer)
  const publicOrigin = exactHttpsUrl(options.publicOrigin)
  const redirectUri = exactHttpsUrl(options.redirectUri)
  if (
    !issuer ||
    !publicOrigin ||
    publicOrigin.pathname !== "/" ||
    !redirectUri ||
    redirectUri.origin !== publicOrigin.origin ||
    redirectUri.pathname !== callbackPath ||
    typeof options.clientId !== "string" ||
    options.clientId.length === 0 ||
    options.clientId.length > 256 ||
    typeof options.clientSecret !== "string" ||
    options.clientSecret.length === 0 ||
    options.clientSecret.length > 16_384 ||
    !(options.principalHmacKey instanceof Uint8Array) ||
    options.principalHmacKey.byteLength < 32 ||
    options.principalHmacKey.byteLength > 1_024 ||
    !Array.isArray(options.allowedSubjects) ||
    options.allowedSubjects.length === 0 ||
    options.allowedSubjects.length > 256 ||
    options.allowedSubjects.some(
      (subject) =>
        typeof subject !== "string" ||
        subject.length === 0 ||
        subject.length > 256
    ) ||
    new Set(options.allowedSubjects).size !== options.allowedSubjects.length
  ) {
    throw new OidcAuthenticationError()
  }
  networkTimeout(options.networkTimeoutMs)
}

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      }
    )
  })
}

async function boundedResponse(
  response: Response,
  signal: AbortSignal
): Promise<Response> {
  const declaredLength = response.headers.get("content-length")
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > maxProviderResponseBodyBytes)
  ) {
    try {
      void response.body?.cancel().catch(() => undefined)
    } catch {
      // Cancellation is best-effort after refusing an untrusted response.
    }
    throw new OidcAuthenticationError()
  }
  if (!response.body) return response

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await withAbortSignal(reader.read(), signal)
      if (done) break
      received += value.byteLength
      if (received > maxProviderResponseBodyBytes) {
        throw new OidcAuthenticationError()
      }
      chunks.push(value)
    }
  } catch (error) {
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      // Preserve the bounded-read failure, not a transport cancellation error.
    }
    throw error
  }

  const body = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.set("content-length", String(received))
  const bounded = new Response(received === 0 ? null : body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
  if (response.url) {
    Object.defineProperty(bounded, "url", { value: response.url })
  }
  return bounded
}

function deadlineFetch(fetcher: OidcFetch, timeoutMs: number): CustomFetch {
  return async (url, init) => {
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = init.signal
      ? AbortSignal.any([init.signal, deadline])
      : deadline
    const response = await withAbortSignal(
      fetcher(url, { ...init, signal } as RequestInit),
      signal
    )
    return boundedResponse(response, signal)
  }
}

async function discoverProvider<Session>(
  options: OidcCoreOptions<Session>
): Promise<OidcProvider> {
  const timeoutMs = networkTimeout(options.networkTimeoutMs)
  const configuration = await discovery(
    new URL(options.issuer),
    options.clientId,
    options.clientSecret,
    undefined,
    {
      execute: [enableNonRepudiationChecks],
      timeout: timeoutMs / 1_000,
      [customFetch]: deadlineFetch(options.fetcher ?? fetch, timeoutMs),
    }
  )
  return {
    buildAuthorizationUrl(parameters) {
      return buildAuthorizationUrl(configuration, parameters)
    },
    async authorizationCodeGrant(callbackUrl, checks) {
      const tokens = await authorizationCodeGrant(configuration, callbackUrl, {
        ...checks,
        idTokenExpected: true,
      })
      const claims = tokens.claims()
      if (
        !claims ||
        typeof claims.iss !== "string" ||
        typeof claims.sub !== "string" ||
        claims.sub.length === 0 ||
        (claims.azp !== undefined && claims.azp !== options.clientId)
      ) {
        throw new OidcAuthenticationError()
      }
      return { issuer: claims.iss, subject: claims.sub }
    },
  }
}

export function createOidcCore<Session>(
  options: OidcCoreOptions<Session>
): OidcCore<Session> {
  validateOptions(options)
  const pending = new Map<string, PendingFlow>()
  const allowedSubjects = new Set(options.allowedSubjects)
  const now = options.now ?? Date.now
  let discoveredProvider: Promise<OidcProvider> | undefined
  let activeFlows = 0

  function oidcProvider(): Promise<OidcProvider> {
    if (options.provider) return Promise.resolve(options.provider)
    if (!discoveredProvider) {
      const attempt = discoverProvider(options)
      discoveredProvider = attempt
      void attempt.catch(() => {
        if (discoveredProvider === attempt) discoveredProvider = undefined
      })
    }
    return discoveredProvider
  }

  return {
    async begin(returnPath: string) {
      let admissionHeld = false
      try {
        returnPath = applicationPath(returnPath, options.publicOrigin)
        const currentTime = now()
        for (const [flowId, flow] of pending) {
          if (flow.expiresAt <= currentTime) {
            pending.delete(flowId)
            activeFlows -= 1
          }
        }
        if (activeFlows >= 256) {
          throw new OidcAuthenticationError()
        }
        activeFlows += 1
        admissionHeld = true
        const provider = await oidcProvider()
        const state = randomState()
        const codeVerifier = randomPKCECodeVerifier()
        const nonce = randomNonce()
        const flowId = randomState()
        const codeChallenge = await calculatePKCECodeChallenge(codeVerifier)
        const authorizationUrl = provider.buildAuthorizationUrl({
          redirect_uri: options.redirectUri,
          scope: "openid",
          response_type: "code",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
          nonce,
        })
        if (!isTrustedAuthorizationUrl(authorizationUrl, options.issuer)) {
          throw new OidcAuthenticationError()
        }
        pending.set(flowId, {
          codeVerifier,
          expiresAt: currentTime + 300_000,
          nonce,
          returnPath,
          state,
        })
        admissionHeld = false
        return {
          authorizationUrl,
          flowCookie: `${flowCookieName}=${flowId}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`,
        }
      } catch {
        if (admissionHeld) activeFlows -= 1
        throw new OidcAuthenticationError()
      }
    },
    async complete(callbackUrl: URL, cookieHeader: string | null) {
      const flowId = flowIdFromCookie(cookieHeader)
      if (!flowId) {
        return { status: "rejected", flowCookie: clearFlowCookie() }
      }
      const flow = pending.get(flowId)
      if (!flow) {
        return { status: "rejected" as const, flowCookie: clearFlowCookie() }
      }
      pending.delete(flowId)
      try {
        if (
          flow.expiresAt <= now() ||
          !isConfiguredCallback(callbackUrl, options.redirectUri)
        ) {
          return { status: "rejected" as const, flowCookie: clearFlowCookie() }
        }
        const provider = await oidcProvider()
        const identity = await provider.authorizationCodeGrant(callbackUrl, {
          expectedNonce: flow.nonce,
          expectedState: flow.state,
          pkceCodeVerifier: flow.codeVerifier,
        })
        if (
          identity.issuer !== options.issuer ||
          !allowedSubjects.has(identity.subject)
        ) {
          return { status: "rejected" as const, flowCookie: clearFlowCookie() }
        }
        const issued = await options.sessionIssuer.issue({
          principalId: principalId(
            options.principalHmacKey,
            identity.issuer,
            identity.subject
          ),
        })
        return {
          status: "authenticated" as const,
          returnPath: flow.returnPath,
          session: issued.session,
          sessionCookie: issued.cookie,
          flowCookie: clearFlowCookie(),
        }
      } catch {
        return { status: "rejected" as const, flowCookie: clearFlowCookie() }
      } finally {
        activeFlows -= 1
      }
    },
  }
}
