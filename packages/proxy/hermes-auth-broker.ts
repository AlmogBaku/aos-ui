import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"
import { z } from "zod"

const DEFAULT_FLOW_TTL_MS = 5 * 60_000
const DEFAULT_MAX_FLOWS = 256
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_REFRESH_SKEW_MS = 60_000
const MAX_URL_LENGTH = 4096
const MAX_COOKIE_BYTES = 16 * 1024

const StatusSchema = z
  .object({
    auth_required: z.boolean(),
    auth_flows: z.array(z.string().min(1).max(64)).max(32),
  })
  .passthrough()

const ProvidersSchema = z.object({
  providers: z
    .array(
      z
        .object({
          name: z.string().min(1).max(128),
          display_name: z.string().min(1).max(256),
          supports_password: z.boolean(),
        })
        .passthrough()
    )
    .max(64),
})

const NativeTokenSchema = z
  .object({
    access_token: z.string().min(1).max(16_384),
    refresh_token: z.string().min(1).max(16_384),
    token_type: z.literal("Bearer"),
    expires_at: z.number().int().positive().finite(),
    provider: z.string().min(1).max(128),
    user_id: z.string().min(1).max(512),
  })
  .strict()

export type HermesBrowserAuthBinding = {
  principalId: string
  lane: string
  browserSessionId: string
  /** Exact proxy callback URL registered as Hermes' public auth callback. */
  callbackUrl: string
  /** Same-origin application route restored after a successful login. */
  returnPath: string
}

export type HermesCredentialScope = Pick<
  HermesBrowserAuthBinding,
  "principalId" | "lane"
>

export type HermesBrowserAuthUnavailableReason =
  | "callback-mismatch"
  | "hermes-auth-not-required"
  | "hermes-authentication-required"
  | "identity-origin-not-allowed"
  | "invalid-native-response"
  | "native-pkce-unavailable"
  | "password-provider-unsupported"
  | "provider-selection-required"
  | "provider-temporarily-unavailable"

export type HermesBrowserAuthStart =
  | { status: "redirect"; response: Response }
  | { status: "unavailable"; reason: HermesBrowserAuthUnavailableReason }

export type HermesBrowserAuthErrorCode =
  | "invalid-flow"
  | "invalid-request"
  | "provider-temporarily-unavailable"
  | "session-expired"

/** A bounded public classification. Native error text is never retained. */
export class HermesBrowserAuthenticationError extends Error {
  constructor(readonly code: HermesBrowserAuthErrorCode) {
    super("Hermes authentication failed")
    this.name = "HermesBrowserAuthenticationError"
  }
}

export type HermesBrowserAuthBrokerOptions = {
  baseUrl: string
  publicOrigin: string
  callbackUrl: string
  allowedIdentityOrigins: readonly string[]
  provider?: string
  fetcher?: typeof fetch
  clock?: () => number
  randomBytes?: (size: number) => Uint8Array
  flowTtlMs?: number
  maxFlows?: number
  maxResponseBytes?: number
  timeoutMs?: number
  credentialRefreshSkewMs?: number
}

type NormalizedBinding = {
  principalId: string
  lane: string
  browserSessionId: string
  callbackUrl: string
  returnPath: string
}

type PendingFlow = {
  binding: NormalizedBinding
  provider: string
  providerState: string
  clientState: string
  verifier: string
  nativeRedirect: string
  cookies: CookieJar
  expiresAt: number
}

type NativeCredentials = z.infer<typeof NativeTokenSchema>

type StoredCredentials = NativeCredentials & { browserSessionId: string }

class NativeResponseError extends Error {
  constructor(readonly kind: "authentication" | "invalid" | "temporary") {
    super("Hermes native response rejected")
    this.name = "NativeResponseError"
  }
}

function normalizeBaseUrl(value: string) {
  try {
    const url = new URL(value)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.href.replace(/\/$/u, "")
  } catch {
    throw new HermesBrowserAuthenticationError("invalid-request")
  }
}

function normalizeHttpsOrigin(value: string) {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.origin
  } catch {
    throw new HermesBrowserAuthenticationError("invalid-request")
  }
}

function normalizePublicOrigin(value: string) {
  try {
    const url = new URL(value)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.origin
  } catch {
    throw new HermesBrowserAuthenticationError("invalid-request")
  }
}

function normalizeCallback(value: string, publicOrigin: string) {
  try {
    if (value.length > MAX_URL_LENGTH) throw new Error()
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.origin !== publicOrigin ||
      url.username ||
      url.password ||
      !url.pathname.endsWith("/auth/callback") ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.href
  } catch {
    throw new HermesBrowserAuthenticationError("invalid-request")
  }
}

function hasControlCharacters(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function normalizeBoundedIdentifier(value: string) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    hasControlCharacters(value)
  )
    throw new HermesBrowserAuthenticationError("invalid-request")
  return value
}

function normalizeReturnPath(value: string, publicOrigin: string) {
  try {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 2048 ||
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\") ||
      hasControlCharacters(value)
    )
      throw new Error()
    const url = new URL(value, publicOrigin)
    if (url.origin !== publicOrigin) throw new Error()
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    throw new HermesBrowserAuthenticationError("invalid-request")
  }
}

function encodeRandom(value: Uint8Array) {
  return Buffer.from(value).toString("base64url")
}

function credentialKey(scope: HermesCredentialScope) {
  return JSON.stringify([
    normalizeBoundedIdentifier(scope.principalId),
    normalizeBoundedIdentifier(scope.lane),
  ])
}

function headerSetCookies(headers: Headers): readonly string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.()
  if (values?.length) return values
  const combined = headers.get("set-cookie")
  return combined ? [combined] : []
}

class CookieJar {
  readonly #values = new Map<string, string>()

  absorb(headers: Headers) {
    for (const raw of headerSetCookies(headers)) {
      if (raw.length > MAX_COOKIE_BYTES)
        throw new NativeResponseError("invalid")
      const [pair, ...attributes] = raw.split(";")
      const separator = pair.indexOf("=")
      if (separator < 1) throw new NativeResponseError("invalid")
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name))
        throw new NativeResponseError("invalid")
      const expired = attributes.some((attribute) =>
        /^\s*max-age\s*=\s*0\s*$/iu.test(attribute)
      )
      if (!value || expired) this.#values.delete(name)
      else this.#values.set(name, value)
    }
  }

  header() {
    const value = [...this.#values]
      .map(([name, contents]) => `${name}=${contents}`)
      .join("; ")
    return value || undefined
  }
}

async function boundedJson(response: Response, maxBytes: number) {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)
      throw new NativeResponseError("invalid")
  }
  if (!response.body) throw new NativeResponseError("invalid")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    total += result.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new NativeResponseError("invalid")
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown
  } catch {
    throw new NativeResponseError("invalid")
  }
}

function unavailable(error: unknown): HermesBrowserAuthStart {
  if (error instanceof NativeResponseError) {
    if (error.kind === "authentication")
      return {
        status: "unavailable",
        reason: "hermes-authentication-required",
      }
    if (error.kind === "temporary")
      return {
        status: "unavailable",
        reason: "provider-temporarily-unavailable",
      }
  }
  return { status: "unavailable", reason: "invalid-native-response" }
}

/**
 * Server-only broker for Hermes' RFC 8252 native flow.
 *
 * The browser sees only an allowlisted identity redirect. Hermes cookies,
 * its private loopback target, native codes, and rotating tokens stay here.
 */
export function createHermesBrowserAuthBroker(
  options: HermesBrowserAuthBrokerOptions
) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const publicOrigin = normalizePublicOrigin(options.publicOrigin)
  const callbackUrl = normalizeCallback(options.callbackUrl, publicOrigin)
  const allowedIdentityOrigins = new Set(
    options.allowedIdentityOrigins.map(normalizeHttpsOrigin)
  )
  if (!allowedIdentityOrigins.size)
    throw new HermesBrowserAuthenticationError("invalid-request")
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  const clock = options.clock ?? Date.now
  const randomBytes = options.randomBytes ?? nodeRandomBytes
  const flowTtlMs = options.flowTtlMs ?? DEFAULT_FLOW_TTL_MS
  const maxFlows = options.maxFlows ?? DEFAULT_MAX_FLOWS
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const credentialRefreshSkewMs =
    options.credentialRefreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS
  if (
    !Number.isSafeInteger(flowTtlMs) ||
    flowTtlMs < 1_000 ||
    flowTtlMs > 10 * 60_000 ||
    !Number.isSafeInteger(maxFlows) ||
    maxFlows < 1 ||
    maxFlows > 10_000 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 256 ||
    maxResponseBytes > 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000 ||
    !Number.isSafeInteger(credentialRefreshSkewMs) ||
    credentialRefreshSkewMs < 0 ||
    credentialRefreshSkewMs > 10 * 60_000
  )
    throw new HermesBrowserAuthenticationError("invalid-request")

  const pending = new Map<string, PendingFlow>()
  const credentialsByScope = new Map<string, StoredCredentials>()
  const refreshes = new Map<string, Promise<StoredCredentials>>()

  const request = async (path: string, init: RequestInit = {}) => {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new NativeResponseError("invalid")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      })
      if (response.status === 401 || response.status === 403)
        throw new NativeResponseError("authentication")
      if (response.status >= 500) throw new NativeResponseError("temporary")
      return response
    } catch (error) {
      if (error instanceof NativeResponseError) throw error
      throw new NativeResponseError("temporary")
    } finally {
      clearTimeout(timer)
    }
  }

  const readJson = async (response: Response) => {
    if (!response.ok || response.redirected || response.status >= 300)
      throw new NativeResponseError("invalid")
    return boundedJson(response, maxResponseBytes)
  }

  const normalizeBinding = (input: HermesBrowserAuthBinding) => {
    let suppliedCallback: URL
    try {
      suppliedCallback = new URL(input.callbackUrl)
    } catch {
      throw new HermesBrowserAuthenticationError("invalid-request")
    }
    suppliedCallback.search = ""
    suppliedCallback.hash = ""
    if (suppliedCallback.href !== callbackUrl)
      throw new HermesBrowserAuthenticationError("invalid-request")
    return {
      principalId: normalizeBoundedIdentifier(input.principalId),
      lane: normalizeBoundedIdentifier(input.lane),
      browserSessionId: normalizeBoundedIdentifier(input.browserSessionId),
      callbackUrl,
      returnPath: normalizeReturnPath(input.returnPath, publicOrigin),
    } satisfies NormalizedBinding
  }

  const forwardedHeaders = () => {
    const callback = new URL(callbackUrl)
    const suffix = "/auth/callback"
    const prefix = callback.pathname.slice(0, -suffix.length)
    return {
      "x-forwarded-host": callback.host,
      "x-forwarded-proto": callback.protocol.slice(0, -1),
      ...(prefix ? { "x-forwarded-prefix": prefix } : {}),
    }
  }

  const collectExpiredFlows = () => {
    const now = clock()
    for (const [state, flow] of pending)
      if (flow.expiresAt <= now) pending.delete(state)
  }

  const chooseProvider = (
    payload: z.infer<typeof ProvidersSchema>
  ): string | undefined => {
    const oauth = payload.providers.filter(
      (provider) => !provider.supports_password
    )
    if (options.provider)
      return oauth.some(({ name }) => name === options.provider)
        ? options.provider
        : undefined
    return oauth.length === 1 ? oauth[0].name : undefined
  }

  const begin = async (
    input: HermesBrowserAuthBinding
  ): Promise<HermesBrowserAuthStart> => {
    const binding = normalizeBinding(input)
    collectExpiredFlows()
    try {
      const status = StatusSchema.safeParse(
        await readJson(
          await request("/api/status", {
            headers: { accept: "application/json" },
          })
        )
      )
      if (!status.success) throw new NativeResponseError("invalid")
      if (!status.data.auth_required)
        return { status: "unavailable", reason: "hermes-auth-not-required" }
      if (!status.data.auth_flows.includes("native_pkce"))
        return { status: "unavailable", reason: "native-pkce-unavailable" }

      const providers = ProvidersSchema.safeParse(
        await readJson(
          await request("/api/auth/providers", {
            headers: { accept: "application/json" },
          })
        )
      )
      if (!providers.success) throw new NativeResponseError("invalid")
      if (
        providers.data.providers.length > 0 &&
        providers.data.providers.every(
          ({ supports_password }) => supports_password
        )
      )
        return {
          status: "unavailable",
          reason: "password-provider-unsupported",
        }
      const provider = chooseProvider(providers.data)
      if (!provider)
        return {
          status: "unavailable",
          reason: "provider-selection-required",
        }

      if (pending.size >= maxFlows)
        return {
          status: "unavailable",
          reason: "provider-temporarily-unavailable",
        }

      const verifier = encodeRandom(randomBytes(64))
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url")
      const clientState = encodeRandom(randomBytes(32))
      const nonce = encodeRandom(randomBytes(32))
      const nativeRedirect = `http://127.0.0.1/aos-hermes-native/${nonce}`
      const authorize = new URL(`${baseUrl}/auth/native/authorize`)
      authorize.searchParams.set("provider", provider)
      authorize.searchParams.set("code_challenge", challenge)
      authorize.searchParams.set("code_challenge_method", "S256")
      authorize.searchParams.set("redirect_uri", nativeRedirect)
      authorize.searchParams.set("state", clientState)
      const response = await request(
        `${authorize.pathname}${authorize.search}`,
        { headers: forwardedHeaders() }
      )
      if (![301, 302, 303, 307, 308].includes(response.status))
        throw new NativeResponseError("invalid")
      const location = response.headers.get("location")
      if (!location || location.length > MAX_URL_LENGTH)
        throw new NativeResponseError("invalid")
      let identity: URL
      try {
        identity = new URL(location)
      } catch {
        throw new NativeResponseError("invalid")
      }
      if (
        identity.protocol !== "https:" ||
        identity.username ||
        identity.password ||
        !allowedIdentityOrigins.has(identity.origin)
      )
        return {
          status: "unavailable",
          reason: "identity-origin-not-allowed",
        }
      if (
        identity.searchParams.getAll("redirect_uri").length !== 1 ||
        identity.searchParams.get("redirect_uri") !== callbackUrl
      )
        return { status: "unavailable", reason: "callback-mismatch" }
      const providerState = identity.searchParams.get("state")
      if (
        !providerState ||
        providerState.length > 512 ||
        identity.searchParams.getAll("state").length !== 1 ||
        pending.has(providerState)
      )
        throw new NativeResponseError("invalid")

      const cookies = new CookieJar()
      cookies.absorb(response.headers)
      if (!cookies.header()) throw new NativeResponseError("invalid")
      pending.set(providerState, {
        binding,
        provider,
        providerState,
        clientState,
        verifier,
        nativeRedirect,
        cookies,
        expiresAt: clock() + flowTtlMs,
      })
      return {
        status: "redirect",
        response: new Response(null, {
          status: 302,
          headers: {
            "cache-control": "no-store",
            location: identity.href,
            "referrer-policy": "no-referrer",
          },
        }),
      }
    } catch (error) {
      if (error instanceof HermesBrowserAuthenticationError) throw error
      return unavailable(error)
    }
  }

  const complete = async (
    input: HermesBrowserAuthBinding
  ): Promise<{ status: "authenticated"; returnPath: string }> => {
    let callback: URL
    try {
      if (input.callbackUrl.length > MAX_URL_LENGTH) throw new Error()
      callback = new URL(input.callbackUrl)
    } catch {
      throw new HermesBrowserAuthenticationError("invalid-request")
    }
    const bareCallback = new URL(callback)
    bareCallback.search = ""
    bareCallback.hash = ""
    if (bareCallback.href !== callbackUrl)
      throw new HermesBrowserAuthenticationError("invalid-request")
    const allowedParameters = new Set([
      "code",
      "state",
      "error",
      "error_description",
    ])
    for (const key of callback.searchParams.keys())
      if (
        !allowedParameters.has(key) ||
        callback.searchParams.getAll(key).length !== 1
      )
        throw new HermesBrowserAuthenticationError("invalid-request")
    const providerState = callback.searchParams.get("state")
    const code = callback.searchParams.get("code")
    const providerError = callback.searchParams.get("error")
    if (
      !providerState ||
      providerState.length > 512 ||
      (code && code.length > 4096) ||
      (providerError && providerError.length > 256)
    )
      throw new HermesBrowserAuthenticationError("invalid-request")

    const flow = pending.get(providerState)
    pending.delete(providerState)
    if (!flow || flow.expiresAt <= clock())
      throw new HermesBrowserAuthenticationError("invalid-flow")
    const expectedBinding = flow.binding
    if (
      input.principalId !== expectedBinding.principalId ||
      input.lane !== expectedBinding.lane ||
      input.browserSessionId !== expectedBinding.browserSessionId ||
      bareCallback.href !== expectedBinding.callbackUrl
    )
      throw new HermesBrowserAuthenticationError("invalid-flow")
    if (providerError || !code)
      throw new HermesBrowserAuthenticationError("invalid-flow")

    try {
      const nativeCallback = new URL(`${baseUrl}/auth/callback`)
      nativeCallback.searchParams.set("code", code)
      nativeCallback.searchParams.set("state", providerState)
      const cookie = flow.cookies.header()
      if (!cookie) throw new NativeResponseError("invalid")
      const callbackResponse = await request(
        `${nativeCallback.pathname}${nativeCallback.search}`,
        {
          headers: { ...forwardedHeaders(), cookie },
        }
      )
      flow.cookies.absorb(callbackResponse.headers)
      if (![301, 302, 303, 307, 308].includes(callbackResponse.status))
        throw new NativeResponseError("invalid")
      const redirect = callbackResponse.headers.get("location")
      if (!redirect || redirect.length > MAX_URL_LENGTH)
        throw new NativeResponseError("invalid")
      let nativeResult: URL
      try {
        nativeResult = new URL(redirect)
      } catch {
        throw new NativeResponseError("invalid")
      }
      const expectedRedirect = new URL(flow.nativeRedirect)
      if (
        nativeResult.origin !== expectedRedirect.origin ||
        nativeResult.pathname !== expectedRedirect.pathname ||
        nativeResult.username ||
        nativeResult.password ||
        nativeResult.hash ||
        nativeResult.searchParams.getAll("code").length !== 1 ||
        nativeResult.searchParams.getAll("state").length !== 1 ||
        nativeResult.searchParams.get("state") !== flow.clientState
      )
        throw new NativeResponseError("invalid")
      const gatewayCode = nativeResult.searchParams.get("code")
      if (!gatewayCode || gatewayCode.length > 4096)
        throw new NativeResponseError("invalid")

      const tokenResponse = await request("/auth/native/token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: gatewayCode,
          code_verifier: flow.verifier,
        }),
      })
      const parsed = NativeTokenSchema.safeParse(await readJson(tokenResponse))
      if (!parsed.success || parsed.data.provider !== flow.provider)
        throw new NativeResponseError("invalid")
      credentialsByScope.set(credentialKey(expectedBinding), {
        ...parsed.data,
        browserSessionId: expectedBinding.browserSessionId,
      })
      return {
        status: "authenticated",
        returnPath: expectedBinding.returnPath,
      }
    } catch (error) {
      if (error instanceof HermesBrowserAuthenticationError) throw error
      if (error instanceof NativeResponseError && error.kind === "temporary")
        throw new HermesBrowserAuthenticationError(
          "provider-temporarily-unavailable"
        )
      throw new HermesBrowserAuthenticationError("invalid-flow")
    }
  }

  const refresh = async (
    key: string,
    stored: StoredCredentials
  ): Promise<StoredCredentials> => {
    try {
      const response = await request("/auth/native/refresh", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          refresh_token: stored.refresh_token,
          provider: stored.provider,
        }),
      })
      const parsed = NativeTokenSchema.safeParse(await readJson(response))
      if (
        !parsed.success ||
        parsed.data.provider !== stored.provider ||
        parsed.data.user_id !== stored.user_id
      )
        throw new NativeResponseError("invalid")
      const rotated = {
        ...parsed.data,
        browserSessionId: stored.browserSessionId,
      }
      credentialsByScope.set(key, rotated)
      return rotated
    } catch (error) {
      if (
        error instanceof NativeResponseError &&
        error.kind === "authentication"
      ) {
        credentialsByScope.delete(key)
        throw new HermesBrowserAuthenticationError("session-expired")
      }
      if (error instanceof NativeResponseError && error.kind === "temporary")
        throw new HermesBrowserAuthenticationError(
          "provider-temporarily-unavailable"
        )
      credentialsByScope.delete(key)
      throw new HermesBrowserAuthenticationError("session-expired")
    }
  }

  const credentials = async (scope: HermesCredentialScope) => {
    const key = credentialKey(scope)
    let stored = credentialsByScope.get(key)
    if (!stored) throw new HermesBrowserAuthenticationError("session-expired")
    if (stored.expires_at * 1000 <= clock() + credentialRefreshSkewMs) {
      let operation = refreshes.get(key)
      if (!operation) {
        operation = refresh(key, stored)
        refreshes.set(key, operation)
        const clear = () => {
          if (refreshes.get(key) === operation) refreshes.delete(key)
        }
        void operation.then(clear, clear)
      }
      stored = await operation
    }
    return { authorization: `Bearer ${stored.access_token}` } as const
  }

  const authState = (scope: HermesCredentialScope) => {
    const stored = credentialsByScope.get(credentialKey(scope))
    return stored
      ? ({ status: "authenticated" } as const)
      : ({ status: "authentication-required" } as const)
  }

  return { authState, begin, complete, credentials }
}
