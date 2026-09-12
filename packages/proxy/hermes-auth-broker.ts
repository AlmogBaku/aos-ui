import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"
import { CookieJar } from "tough-cookie"
import { z } from "zod"

const DEFAULT_FLOW_TTL_MS = 5 * 60_000
const DEFAULT_MAX_FLOWS = 256
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_REFRESH_SKEW_MS = 60_000
const MAX_URL_LENGTH = 4096
const MAX_COOKIE_HEADER_BYTES = 16 * 1024
const MAX_COOKIE_COUNT = 32
const MAX_SET_COOKIE_BYTES = 4096

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
    refresh_token: z.string().max(16_384),
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
  cookies: BoundedCookieJar
  expiresAt: number
}

type NativeCredentials = z.infer<typeof NativeTokenSchema>

type StoredCredentials = NativeCredentials & {
  browserSessionId: string
  generation: number
}

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
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
        )) ||
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
      url.origin !== publicOrigin ||
      url.protocol !== new URL(publicOrigin).protocol ||
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
    if (/%(?![0-9a-f]{2})/iu.test(value)) throw new Error()
    let decoded = value
    let decodingSettled = false
    for (let depth = 0; depth < 8; depth += 1) {
      if (
        decoded.startsWith("//") ||
        decoded.includes("\\") ||
        hasControlCharacters(decoded) ||
        /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(decoded)
      )
        throw new Error()
      let next: string
      try {
        next = decodeURIComponent(decoded)
      } catch {
        // A literal percent may appear after decoding `%25`; the original
        // encoding was already proven well formed above.
        decodingSettled = true
        break
      }
      if (next === decoded) {
        decodingSettled = true
        break
      }
      decoded = next
    }
    if (!decodingSettled) throw new Error()
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

class BoundedCookieJar {
  readonly #jar = new CookieJar(undefined, {
    // `.test` is used by deterministic deployments/tests; domain matching
    // remains strict and cross-host Domain attributes are still rejected.
    allowSpecialUseDomain: true,
    looseMode: false,
    prefixSecurity: "strict",
    rejectPublicSuffixes: true,
  })

  async absorb(headers: Headers, sourceUrl: string) {
    const values = headerSetCookies(headers)
    if (values.length > MAX_COOKIE_COUNT)
      throw new NativeResponseError("invalid")
    try {
      for (const raw of values) {
        if (Buffer.byteLength(raw) > MAX_SET_COOKIE_BYTES)
          throw new NativeResponseError("invalid")
        await this.#jar.setCookie(raw, sourceUrl, { ignoreError: false })
      }
    } catch (error) {
      if (error instanceof NativeResponseError) throw error
      throw new NativeResponseError("invalid")
    }
  }

  async header(destinationUrl: string) {
    const cookies = await this.#jar.getCookies(destinationUrl)
    if (cookies.length > MAX_COOKIE_COUNT)
      throw new NativeResponseError("invalid")
    const value = await this.#jar.getCookieString(destinationUrl)
    if (Buffer.byteLength(value) > MAX_COOKIE_HEADER_BYTES)
      throw new NativeResponseError("invalid")
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
  const credentialGenerations = new Map<string, number>()
  const refreshes = new Map<string, Promise<StoredCredentials>>()
  let activeFlowSlots = 0
  const responseLifecycles = new WeakMap<
    Response,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >()

  const releaseResponse = async (response: Response) => {
    const lifecycle = responseLifecycles.get(response)
    if (lifecycle) {
      clearTimeout(lifecycle.timer)
      responseLifecycles.delete(response)
    }
    if (response.body && !response.bodyUsed) {
      void response.body.cancel().catch(() => {
        // An aborted body may already be errored; there is nothing left to drain.
      })
    }
  }

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
      responseLifecycles.set(response, { controller, timer })
      if (response.status === 401 || response.status === 403) {
        await releaseResponse(response)
        throw new NativeResponseError("authentication")
      }
      if (response.status >= 500) {
        await releaseResponse(response)
        throw new NativeResponseError("temporary")
      }
      return response
    } catch (error) {
      clearTimeout(timer)
      if (error instanceof NativeResponseError) throw error
      throw new NativeResponseError("temporary")
    }
  }

  const readJson = async (response: Response) => {
    const lifecycle = responseLifecycles.get(response)
    try {
      if (!response.ok || response.redirected || response.status >= 300)
        throw new NativeResponseError("invalid")
      return await boundedJson(response, maxResponseBytes)
    } catch (error) {
      if (lifecycle?.controller.signal.aborted)
        throw new NativeResponseError("temporary")
      throw error
    } finally {
      await releaseResponse(response)
    }
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
    const lane = normalizeBoundedIdentifier(input.lane)
    if (lane !== "operator")
      throw new HermesBrowserAuthenticationError("invalid-request")
    return {
      principalId: normalizeBoundedIdentifier(input.principalId),
      lane,
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
      host: callback.host,
      "x-forwarded-host": callback.host,
      "x-forwarded-proto": callback.protocol.slice(0, -1),
      ...(prefix ? { "x-forwarded-prefix": prefix } : {}),
    }
  }

  const publicNativeAuthorizeUrl = () => {
    const url = new URL(callbackUrl)
    url.pathname = `${url.pathname.slice(0, -"/auth/callback".length)}/auth/native/authorize`
    return url.href
  }

  const collectExpiredFlows = () => {
    const now = clock()
    for (const [state, flow] of pending) {
      if (flow.expiresAt > now) continue
      pending.delete(state)
      activeFlowSlots -= 1
    }
  }

  const nextCredentialGeneration = (key: string) => {
    const generation = (credentialGenerations.get(key) ?? 0) + 1
    credentialGenerations.set(key, generation)
    return generation
  }

  const removeCredentials = (key: string) => {
    nextCredentialGeneration(key)
    credentialsByScope.delete(key)
    refreshes.delete(key)
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
    let reservedSlot = false
    let storedFlow = false
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

      if (activeFlowSlots >= maxFlows)
        return {
          status: "unavailable",
          reason: "provider-temporarily-unavailable",
        }
      activeFlowSlots += 1
      reservedSlot = true

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
      let location: string | null
      const cookies = new BoundedCookieJar()
      try {
        if (![301, 302, 303, 307, 308].includes(response.status))
          throw new NativeResponseError("invalid")
        location = response.headers.get("location")
        if (!location || location.length > MAX_URL_LENGTH)
          throw new NativeResponseError("invalid")
        await cookies.absorb(response.headers, publicNativeAuthorizeUrl())
        if (!(await cookies.header(callbackUrl)))
          throw new NativeResponseError("invalid")
      } finally {
        await releaseResponse(response)
      }
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
      storedFlow = true
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
    } finally {
      if (reservedSlot && !storedFlow) activeFlowSlots -= 1
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
    if (flow) activeFlowSlots -= 1
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
      const cookie = await flow.cookies.header(callbackUrl)
      if (!cookie) throw new NativeResponseError("invalid")
      const callbackResponse = await request(
        `${nativeCallback.pathname}${nativeCallback.search}`,
        {
          headers: { ...forwardedHeaders(), cookie },
        }
      )
      let redirect: string | null
      try {
        await flow.cookies.absorb(callbackResponse.headers, callbackUrl)
        if (![301, 302, 303, 307, 308].includes(callbackResponse.status))
          throw new NativeResponseError("invalid")
        redirect = callbackResponse.headers.get("location")
        if (!redirect || redirect.length > MAX_URL_LENGTH)
          throw new NativeResponseError("invalid")
      } finally {
        await releaseResponse(callbackResponse)
      }
      let nativeResult: URL
      try {
        nativeResult = new URL(redirect)
      } catch {
        throw new NativeResponseError("invalid")
      }
      const expectedRedirect = new URL(flow.nativeRedirect)
      const nativeResultKeys = [...nativeResult.searchParams.keys()]
      if (
        nativeResult.origin !== expectedRedirect.origin ||
        nativeResult.pathname !== expectedRedirect.pathname ||
        nativeResult.username ||
        nativeResult.password ||
        nativeResult.hash ||
        nativeResultKeys.length !== 2 ||
        nativeResultKeys.some((key) => key !== "code" && key !== "state") ||
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
      const key = credentialKey(expectedBinding)
      credentialsByScope.set(key, {
        ...parsed.data,
        browserSessionId: expectedBinding.browserSessionId,
        generation: nextCredentialGeneration(key),
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
      const current = credentialsByScope.get(key)
      if (!current || current.generation !== stored.generation) {
        if (current) return current
        throw new HermesBrowserAuthenticationError("session-expired")
      }
      const rotated = {
        ...parsed.data,
        browserSessionId: stored.browserSessionId,
        generation: stored.generation,
      }
      credentialsByScope.set(key, rotated)
      return rotated
    } catch (error) {
      if (
        error instanceof NativeResponseError &&
        error.kind === "authentication"
      ) {
        if (credentialsByScope.get(key)?.generation === stored.generation)
          removeCredentials(key)
        throw new HermesBrowserAuthenticationError("session-expired")
      }
      if (error instanceof NativeResponseError && error.kind === "temporary")
        throw new HermesBrowserAuthenticationError(
          "provider-temporarily-unavailable"
        )
      if (credentialsByScope.get(key)?.generation === stored.generation)
        removeCredentials(key)
      throw new HermesBrowserAuthenticationError("session-expired")
    }
  }

  const credentials = async (scope: HermesCredentialScope) => {
    const key = credentialKey(scope)
    let stored = credentialsByScope.get(key)
    if (!stored) throw new HermesBrowserAuthenticationError("session-expired")
    if (!stored.refresh_token) {
      if (stored.expires_at * 1000 > clock())
        return { authorization: `Bearer ${stored.access_token}` } as const
      removeCredentials(key)
      throw new HermesBrowserAuthenticationError("session-expired")
    }
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

  /** Called by native transports as soon as a 401/403 invalidates the lane. */
  const invalidate = (scope: HermesCredentialScope) => {
    removeCredentials(credentialKey(scope))
  }

  /** Local logout: Hermes exposes no native bearer-revocation operation. */
  const logout = (scope: HermesCredentialScope) => {
    const key = credentialKey(scope)
    removeCredentials(key)
    for (const [state, flow] of pending)
      if (credentialKey(flow.binding) === key) {
        pending.delete(state)
        activeFlowSlots -= 1
      }
  }

  return { authState, begin, complete, credentials, invalidate, logout }
}
