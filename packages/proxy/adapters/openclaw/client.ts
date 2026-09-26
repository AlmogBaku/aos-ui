import {
  GatewayClient,
  GatewayClientRequestError,
  isGatewayProtocolResponseError,
  type DeviceIdentity,
  type GatewayClientOptions,
} from "@openclaw/gateway-client"
import {
  ConnectErrorDetailCodes,
  classifyGatewayConnectFailure,
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "@openclaw/gateway-protocol/connect-error-details"
import { readMissingScopeErrorDetails } from "@openclaw/gateway-protocol/gateway-error-details"
import {
  PROTOCOL_VERSION,
  type EventFrame,
  type HelloOk,
} from "@openclaw/gateway-protocol"

import { Deadline, defaultClock, type Logger } from "../../../lifecycle"
import { failureOf } from "../../core/failures"
import {
  createLink,
  type Link,
  type LinkState,
  type ServerLink,
} from "../../core/link"

/** The bound on one native call and on one dial. */
const CALL_MS = 15_000
/** The bound on a caller waiting for the link, so its call after it ends inside a 30 s admission. */
const START_MS = 10_000

/**
 * The calls that change native state: one sent and never answered may have
 * landed. Every other call is a read, which the caller may simply repeat.
 */
const WRITES: ReadonlySet<string> = new Set([
  "approval.resolve",
  "chat.send",
  "mcp.app.callTool",
  "question.resolve",
  "sessions.abort",
  "sessions.create",
  "sessions.delete",
  "sessions.patch",
])

export type OpenClawRequestOptions = Readonly<{
  signal?: AbortSignal
  expectFinal?: boolean
  onSent?: () => void
  onAccepted?: (payload: unknown) => void
}>

/** The only HelloOk data that later provider leaves may consume. */
export type OpenClawNegotiatedPolicy = Readonly<{
  maxPayload: number
  attachments?: Readonly<{
    maxBytes: number
    maxImageBytes: number
  }>
}>

export type OpenClawGatewayClientOptions = Pick<
  GatewayClientOptions,
  | "caps"
  | "deviceIdentity"
  | "deviceToken"
  | "hostDeps"
  | "maxProtocol"
  | "minProtocol"
  | "mode"
  | "onConnectError"
  | "onClose"
  | "onEvent"
  | "onGap"
  | "onHelloOk"
  | "onReconnectPaused"
  | "role"
  | "scopes"
  | "url"
>

/** The small official-client surface needed before provider operations exist. */
export interface OpenClawGatewayClient {
  start(): void
  stopAndWait(options?: { timeoutMs?: number }): Promise<void>
  negotiatedPolicy?(): OpenClawNegotiatedPolicy | undefined
  request<T>(
    method: string,
    params?: unknown,
    options?: OpenClawRequestOptions
  ): Promise<T>
}

/** Credentials are provisioned by server composition; this client never pairs or persists them. */
export type OpenClawClientCredentials = Readonly<{
  deviceIdentity: DeviceIdentity
  deviceToken: string
  signDevicePayload: (privateKeyPem: string, payload: string) => string
  publicKeyRawBase64UrlFromPem: (publicKeyPem: string) => string
}>

export type OpenClawConnectionFailureKind =
  | "authentication"
  | "credential-rejected"
  | "pairing-required"
  | "rate-limited"
  | "scope-mismatch"
  | "unavailable"

export type OpenClawClientOptions = Readonly<{
  url: string
  /** Read on every dial, so a rotated device token is the next one sent. */
  credentials: () => Promise<OpenClawClientCredentials>
  role: string
  scopes: readonly string[]
  caps: readonly string[]
  onEvent?: (event: EventFrame) => void
  onGap?: (gap: Readonly<{ expected: number; received: number }>) => void
  logger: Logger
  createGatewayClient?: (
    options: OpenClawGatewayClientOptions
  ) => OpenClawGatewayClient
}>

export class OpenClawClientConnectionError extends Error {
  constructor(
    readonly kind: OpenClawConnectionFailureKind,
    options?: ErrorOptions
  ) {
    super(
      kind === "pairing-required"
        ? "OpenClaw device pairing is required"
        : kind === "scope-mismatch"
          ? "OpenClaw device scope is insufficient"
          : kind === "rate-limited"
            ? "OpenClaw authentication is rate limited"
            : kind === "credential-rejected"
              ? "OpenClaw credentials were rejected"
              : kind === "authentication"
                ? "OpenClaw authentication failed"
                : "OpenClaw connection is unavailable",
      options
    )
    this.name = "OpenClawClientConnectionError"
  }
}

export class OpenClawClientUnavailableError extends Error {
  constructor() {
    super("OpenClaw connection is unavailable")
    this.name = "OpenClawClientUnavailableError"
  }
}

export class OpenClawClientRequestError extends Error {
  /** `uncertain`: a write was sent and never answered, so it may have landed. */
  constructor(
    readonly kind: "cancelled" | "rejected" | "timeout" | "unavailable",
    readonly uncertain = false,
    options?: ErrorOptions
  ) {
    super(
      kind === "cancelled"
        ? "OpenClaw request was cancelled"
        : kind === "rejected"
          ? "OpenClaw request was rejected"
          : kind === "timeout"
            ? "OpenClaw request timed out"
            : "OpenClaw connection is unavailable",
      options
    )
    this.name = "OpenClawClientRequestError"
  }
}

/**
 * What a failure to reach the Gateway means: a refusal a redial would meet
 * again needs the operator, anything else may pass.
 */
export function openClawConnectionFailure(cause: unknown) {
  if (
    cause instanceof OpenClawClientConnectionError &&
    cause.kind !== "unavailable" &&
    cause.kind !== "rate-limited"
  )
    return failureOf("runtime_authentication_required", cause)
  if (
    cause instanceof OpenClawClientConnectionError ||
    cause instanceof OpenClawClientUnavailableError
  )
    return failureOf("unavailable", cause)
  return undefined
}

function validNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
}

function validStringList(values: readonly string[], requireValue = false) {
  return (
    (!requireValue || values.length > 0) &&
    values.every((value) => validNonEmptyString(value))
  )
}

function negotiatedPolicy(
  hello: HelloOk
): OpenClawNegotiatedPolicy | undefined {
  const policy = hello.policy
  if (
    !policy ||
    !Number.isSafeInteger(policy.maxPayload) ||
    policy.maxPayload < 1
  )
    return undefined
  const attachments = policy.attachments
  if (
    !attachments ||
    !Number.isSafeInteger(attachments.maxBytes) ||
    attachments.maxBytes < 1 ||
    !Number.isSafeInteger(attachments.maxImageBytes) ||
    attachments.maxImageBytes < 1
  )
    return Object.freeze({ maxPayload: policy.maxPayload })
  return Object.freeze({
    maxPayload: policy.maxPayload,
    attachments: Object.freeze({
      maxBytes: attachments.maxBytes,
      maxImageBytes: attachments.maxImageBytes,
    }),
  })
}

function validateCredentials(
  credentials: OpenClawClientCredentials | undefined
): asserts credentials is OpenClawClientCredentials {
  if (
    !credentials ||
    !validNonEmptyString(credentials.deviceToken) ||
    !validNonEmptyString(credentials.deviceIdentity?.deviceId) ||
    !validNonEmptyString(credentials.deviceIdentity?.privateKeyPem) ||
    !validNonEmptyString(credentials.deviceIdentity?.publicKeyPem) ||
    typeof credentials.signDevicePayload !== "function" ||
    typeof credentials.publicKeyRawBase64UrlFromPem !== "function"
  )
    throw new Error("Invalid OpenClaw credentials")
}

function connectionIssue(error: unknown) {
  const details =
    error instanceof GatewayClientRequestError
      ? error.details
      : error && typeof error === "object" && "details" in error
        ? error.details
        : undefined
  const code = readConnectErrorDetailCode(details)
  const classified = classifyGatewayConnectFailure({ details })
  let kind: OpenClawConnectionFailureKind
  if (
    code === ConnectErrorDetailCodes.AUTH_REQUIRED ||
    code === ConnectErrorDetailCodes.AUTH_UNAUTHORIZED ||
    code === ConnectErrorDetailCodes.PROTOCOL_MISMATCH
  )
    kind = "authentication"
  else if (code === ConnectErrorDetailCodes.PAIRING_REQUIRED)
    kind = "pairing-required"
  else if (
    code === ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH ||
    readMissingScopeErrorDetails(details)
  )
    kind = "scope-mismatch"
  else if (code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED)
    kind = "rate-limited"
  else if (
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED ||
    code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH ||
    code === ConnectErrorDetailCodes.DEVICE_AUTH_INVALID ||
    code === ConnectErrorDetailCodes.DEVICE_AUTH_DEVICE_ID_MISMATCH ||
    code === ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_EXPIRED ||
    code === ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_INVALID ||
    code === ConnectErrorDetailCodes.DEVICE_AUTH_PUBLIC_KEY_INVALID
  )
    kind = "credential-rejected"
  else if (classified.kind === "pairing-required") kind = "pairing-required"
  else if (classified.kind === "scope-mismatch") kind = "scope-mismatch"
  else if (classified.kind === "rate-limited") kind = "rate-limited"
  else if (
    classified.kind === "auth-rejected" ||
    classified.kind === "device-identity-required"
  )
    kind = "credential-rejected"
  else if (classified.kind === "identity-proxy") kind = "authentication"
  else kind = "unavailable"
  const pairing = readPairingConnectErrorDetails(details)
  const pairingRetryable =
    kind === "pairing-required" &&
    (pairing?.pauseReconnect === false ||
      pairing?.recommendedNextStep === "wait_then_retry")
  return { kind, terminal: kind !== "unavailable" && !pairingRetryable }
}

type Waiter = Readonly<{
  resolve: () => void
  reject: (error: Error) => void
}>

/**
 * One Gateway link on the shared link owner: each dial re-reads the
 * credentials and opens its own official client, which retries its own
 * transport until a hello, a refusal, or the dial's deadline. A refusal stops
 * the link until a caller's start dials again; any other failure or drop
 * redials on the owner's backoff.
 */
export class OpenClawClient {
  readonly link: Link
  readonly #options: OpenClawClientOptions
  readonly #waiters = new Set<Waiter>()
  /** Hears a caller who wants the link: it redials a refused link at once. */
  readonly #demand = new Set<(state: LinkState) => void>()
  /** The dial's official client, from its creation until it is released. */
  #gateway?: OpenClawGatewayClient
  /** Why the link is down, until it is next up. */
  #failure?: Error
  #policy?: OpenClawNegotiatedPolicy
  #closing?: Promise<void>
  #stopped = false
  #stop?: Promise<void>

  constructor(options: OpenClawClientOptions) {
    if (
      !validNonEmptyString(options.role) ||
      !validStringList(options.scopes, true) ||
      !validStringList(options.caps)
    )
      throw new Error("Invalid OpenClaw connection policy")
    this.#options = options
    const demand: ServerLink = {
      state: () => "lost",
      subscribe: (listener) => {
        this.#demand.add(listener)
        return () => {
          this.#demand.delete(listener)
        }
      },
    }
    this.link = createLink({
      dial: (signal, lost) => this.#dial(signal, lost),
      publicError: openClawConnectionFailure,
      upstream: demand,
      logger: options.logger,
      clock: defaultClock,
      bindings: { link: "openclaw-gateway" },
    })
    this.link.subscribe((state) => {
      if (state !== "ready") return
      this.#failure = undefined
      this.#settle()
    })
  }

  /**
   * Resolves once the link is up. A refused link dials again at once; one
   * backing off keeps to its backoff. While the breaker holds the dials, a
   * start fails at once. Each call waits on its own deadline, so a failed
   * start is never reused.
   */
  start(): Promise<void> {
    if (this.#stopped)
      return Promise.reject(new OpenClawClientUnavailableError())
    if (this.link.state() === "ready") return Promise.resolve()
    if (
      openClawConnectionFailure(this.#failure)?.kind ===
      "runtime_authentication_required"
    )
      for (const listener of [...this.#demand]) listener("ready")
    if (this.link.held())
      return Promise.reject(
        this.#failure ?? new OpenClawClientUnavailableError()
      )
    const deadline = new Deadline(START_MS)
    const ready = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject }
      this.#waiters.add(waiter)
      deadline.signal.addEventListener("abort", () =>
        this.#waiters.delete(waiter)
      )
    })
    return deadline
      .run(() => ready)
      .catch((error: unknown) => {
        throw deadline.signal.aborted
          ? new OpenClawClientUnavailableError()
          : error
      })
  }

  async request<T>(
    method: string,
    params?: unknown,
    options: OpenClawRequestOptions = {}
  ): Promise<T> {
    const gateway = this.#gateway
    if (!gateway || this.link.state() !== "ready")
      throw this.#failure ?? new OpenClawClientUnavailableError()
    if (options.signal?.aborted)
      throw new OpenClawClientRequestError("cancelled")
    const dispatch = { accepted: false, requestSent: false }
    const deadline = new Deadline(CALL_MS, defaultClock, options.signal)
    try {
      /** Each provider leaf validates its exact method params and result before conversion. */
      return await gateway.request<T>(method, params, {
        signal: deadline.signal,
        expectFinal: options.expectFinal,
        onSent: () => {
          dispatch.requestSent = true
          options.onSent?.()
        },
        onAccepted: (payload) => {
          dispatch.accepted = true
          // The deadline and the caller's cancellation bound admission only;
          // an accepted run's final answer is unbounded.
          deadline.clear()
          options.onAccepted?.(payload)
        },
      })
    } catch (error) {
      throw this.#sanitizeRequestError(
        method,
        error,
        deadline.signal.aborted,
        options.signal,
        dispatch
      )
    } finally {
      deadline.clear()
    }
  }

  stopAndWait(): Promise<void> {
    this.#stop ??= this.#stopClient()
    return this.#stop
  }

  negotiatedPolicy() {
    return this.#policy
  }

  /**
   * Opens one official client on freshly read credentials and resolves with
   * its release once it says hello. Its transport retries run within the
   * dial's deadline; only a refusal or a pause fails the dial early.
   */
  async #dial(signal: AbortSignal, lost: (cause: unknown) => void) {
    let credentials: OpenClawClientCredentials
    try {
      credentials = await this.#options.credentials()
      validateCredentials(credentials)
    } catch (cause) {
      throw this.#failed(
        new OpenClawClientConnectionError("unavailable", { cause })
      )
    }
    signal.throwIfAborted()
    let up = false
    const hello = Promise.withResolvers<void>()
    const current = () => this.#gateway === gateway
    const fail = (error: OpenClawClientConnectionError) => {
      if (!current()) return
      if (!up) return hello.reject(error)
      this.#failure = error
      lost(error)
    }
    const options = this.#options
    const gatewayOptions: OpenClawGatewayClientOptions = {
      url: options.url,
      deviceIdentity: credentials.deviceIdentity,
      deviceToken: credentials.deviceToken,
      hostDeps: {
        signDevicePayload: credentials.signDevicePayload,
        publicKeyRawBase64UrlFromPem: credentials.publicKeyRawBase64UrlFromPem,
      },
      role: options.role,
      scopes: [...options.scopes],
      caps: [...options.caps],
      mode: "backend",
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: (accepted) => {
        if (!current()) return
        if (accepted.protocol !== PROTOCOL_VERSION)
          return fail(new OpenClawClientConnectionError("authentication"))
        this.#policy = negotiatedPolicy(accepted)
        up = true
        hello.resolve()
      },
      onConnectError: (error) => {
        const issue = connectionIssue(error)
        if (issue.terminal)
          fail(new OpenClawClientConnectionError(issue.kind, { cause: error }))
      },
      onReconnectPaused: (info) =>
        fail(
          new OpenClawClientConnectionError(
            connectionIssue({ details: { code: info.detailCode } }).kind
          )
        ),
      onClose: (_code, _reason, info) => {
        if (info?.phase === "post-hello")
          fail(new OpenClawClientConnectionError("unavailable"))
      },
      onEvent: (event) => {
        if (current()) options.onEvent?.(event)
      },
      onGap: (gap) => {
        if (current()) options.onGap?.(gap)
      },
    }
    const gateway =
      options.createGatewayClient?.(gatewayOptions) ??
      new GatewayClient(gatewayOptions)
    this.#gateway = gateway
    try {
      await new Deadline(CALL_MS, defaultClock, signal).run(() => {
        gateway.start()
        return hello.promise
      })
    } catch (error) {
      this.#release(gateway)
      throw this.#failed(
        error instanceof OpenClawClientConnectionError
          ? error
          : new OpenClawClientConnectionError("unavailable", { cause: error })
      )
    }
    return () => this.#release(gateway)
  }

  /** Records why a dial failed and rejects every waiting start with it. */
  #failed(error: OpenClawClientConnectionError) {
    this.#failure = error
    this.#settle(error)
    return error
  }

  /** Stops `gateway` once, if it is still the dial's client. */
  #release(gateway: OpenClawGatewayClient) {
    if (this.#gateway !== gateway) return
    this.#gateway = undefined
    this.#closing = gateway
      .stopAndWait()
      .catch((err: unknown) =>
        this.#options.logger.warn({ err }, "openclaw.gateway.stop_failed")
      )
  }

  /** Resolves every waiting start, or rejects each with `error`. */
  #settle(error?: Error) {
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    for (const waiter of waiters)
      if (error) waiter.reject(error)
      else waiter.resolve()
  }

  #sanitizeRequestError(
    method: string,
    error: unknown,
    aborted: boolean,
    signal: AbortSignal | undefined,
    dispatch: Readonly<{ accepted: boolean; requestSent: boolean }>
  ) {
    const kind = aborted
      ? signal?.aborted
        ? "cancelled"
        : "timeout"
      : isGatewayProtocolResponseError(error)
        ? "rejected"
        : "unavailable"
    return new OpenClawClientRequestError(
      kind,
      kind !== "rejected" &&
        WRITES.has(method) &&
        dispatch.requestSent &&
        !dispatch.accepted,
      { cause: error }
    )
  }

  async #stopClient() {
    this.#stopped = true
    this.link.dispose()
    // A dial still waiting on its hello ends with the link.
    if (this.#gateway) this.#release(this.#gateway)
    this.#settle(new OpenClawClientUnavailableError())
    await this.#closing
  }
}
