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

import { backoffDelay, Deadline, defaultClock } from "../../../lifecycle"

/** The bound on one native call, and on a caller waiting for the link. */
const CALL_MS = 15_000
/** How this client redials once the Gateway pauses its own reconnect. */
const REDIAL_BACKOFF = { baseMs: 1_000, capMs: 30_000 }

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

export type OpenClawConnectionIssue = Readonly<{
  kind: OpenClawConnectionFailureKind
  terminal: boolean
}>

export type OpenClawConnectionClose = Readonly<{
  phase: "pre-hello" | "post-hello"
  recoverable: boolean
}>

export type OpenClawClientOptions = Readonly<{
  url: string
  credentials: OpenClawClientCredentials
  role: string
  scopes: readonly string[]
  caps: readonly string[]
  /** Runs on every accepted hello: the first and each one after a redial. */
  onReady?: () => void
  onConnectionIssue?: (issue: OpenClawConnectionIssue) => void
  onReconnectPaused?: (issue: OpenClawConnectionIssue) => void
  onClose?: (close: OpenClawConnectionClose) => void
  onEvent?: (event: EventFrame) => void
  onGap?: (gap: Readonly<{ expected: number; received: number }>) => void
  createGatewayClient?: (
    options: OpenClawGatewayClientOptions
  ) => OpenClawGatewayClient
}>

export class OpenClawClientConnectionError extends Error {
  constructor(readonly kind: OpenClawConnectionFailureKind) {
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
                : "OpenClaw connection is unavailable"
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
  constructor(
    readonly kind: "cancelled" | "rejected" | "timeout" | "unavailable",
    readonly requestSent = false,
    readonly accepted = false
  ) {
    super(
      kind === "cancelled"
        ? "OpenClaw request was cancelled"
        : kind === "rejected"
          ? "OpenClaw request was rejected"
          : kind === "timeout"
            ? "OpenClaw request timed out"
            : "OpenClaw connection is unavailable"
    )
    this.name = "OpenClawClientRequestError"
  }

  get uncertain() {
    return this.requestSent && !this.accepted
  }
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

function connectionIssue(error: unknown): OpenClawConnectionIssue {
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

/**
 * `idle` has no dial in flight: before the first start, or once the Gateway
 * paused its reconnect. `dialing` waits for a hello, the Gateway's own
 * reconnect included.
 */
type LinkState = "idle" | "dialing" | "ready" | "stopped"

type Waiter = Readonly<{
  resolve: () => void
  reject: (error: Error) => void
}>

export class OpenClawClient {
  private state: LinkState = "idle"
  private readonly gateway: OpenClawGatewayClient
  private readonly onReady?: () => void
  private readonly waiters = new Set<Waiter>()
  private policy?: OpenClawNegotiatedPolicy
  private redial?: ReturnType<typeof setTimeout>
  private redials = 0
  private stop?: Promise<void>

  constructor(options: OpenClawClientOptions) {
    validateCredentials(options.credentials)
    if (
      !validNonEmptyString(options.role) ||
      !validStringList(options.scopes, true) ||
      !validStringList(options.caps)
    )
      throw new Error("Invalid OpenClaw connection policy")
    this.onReady = options.onReady

    const gatewayOptions: OpenClawGatewayClientOptions = {
      url: options.url,
      deviceIdentity: options.credentials.deviceIdentity,
      deviceToken: options.credentials.deviceToken,
      hostDeps: {
        signDevicePayload: options.credentials.signDevicePayload,
        publicKeyRawBase64UrlFromPem:
          options.credentials.publicKeyRawBase64UrlFromPem,
      },
      role: options.role,
      scopes: [...options.scopes],
      caps: [...options.caps],
      mode: "backend",
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: (hello) => this.acceptHello(hello),
      onConnectError: (error) => this.handleConnectError(error, options),
      onReconnectPaused: (info) => {
        const issue = connectionIssue({ details: { code: info.detailCode } })
        options.onReconnectPaused?.({ ...issue, terminal: true })
        this.pause(new OpenClawClientConnectionError(issue.kind))
      },
      onClose: (_code, _reason, info) => {
        if (this.state === "ready") this.state = "dialing"
        options.onClose?.({
          phase: info?.phase ?? "pre-hello",
          recoverable: this.state !== "stopped",
        })
      },
      onEvent: (event) => options.onEvent?.(event),
      onGap: (gap) => options.onGap?.(gap),
    }
    this.gateway =
      options.createGatewayClient?.(gatewayOptions) ??
      new GatewayClient(gatewayOptions)
  }

  /**
   * Resolves once the link is ready, dialing now when no dial is in flight.
   * Each call waits on its own deadline, so a failed start is never reused.
   */
  start(): Promise<void> {
    if (this.state === "ready") return Promise.resolve()
    if (this.state === "stopped")
      return Promise.reject(new OpenClawClientUnavailableError())
    const deadline = new Deadline(CALL_MS)
    const ready = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject }
      this.waiters.add(waiter)
      deadline.signal.addEventListener("abort", () =>
        this.waiters.delete(waiter)
      )
    })
    if (this.state === "idle") this.dial()
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
    if (this.state !== "ready") throw new OpenClawClientUnavailableError()
    if (options.signal?.aborted)
      throw new OpenClawClientRequestError("cancelled")
    const dispatch = { accepted: false, requestSent: false }
    const deadline = new Deadline(CALL_MS, defaultClock, options.signal)
    try {
      /** Each provider leaf validates its exact method params and result before conversion. */
      return await this.gateway.request<T>(method, params, {
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
      throw this.sanitizeRequestError(
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
    this.stop ??= this.stopClient()
    return this.stop
  }

  negotiatedPolicy() {
    return this.policy
  }

  private dial() {
    clearTimeout(this.redial)
    this.state = "dialing"
    try {
      this.gateway.start()
    } catch {
      this.state = "idle"
      this.settle(new OpenClawClientConnectionError("unavailable"))
    }
  }

  /** Every hello is accepted, and its limits replace the last ones. */
  private acceptHello(hello: HelloOk) {
    if (this.state === "stopped") return
    if (hello.protocol !== PROTOCOL_VERSION) {
      this.settle(new OpenClawClientConnectionError("authentication"))
      return
    }
    this.policy = negotiatedPolicy(hello)
    this.state = "ready"
    this.redials = 0
    clearTimeout(this.redial)
    this.onReady?.()
    this.settle()
  }

  private handleConnectError(error: unknown, options: OpenClawClientOptions) {
    const issue = connectionIssue(error)
    options.onConnectionIssue?.(issue)
    if (issue.terminal)
      this.settle(new OpenClawClientConnectionError(issue.kind))
  }

  /** The Gateway stopped redialing on its own; this client redials on a capped backoff. */
  private pause(error: OpenClawClientConnectionError) {
    if (this.state === "stopped") return
    this.state = "idle"
    this.settle(error)
    clearTimeout(this.redial)
    this.redial = setTimeout(
      () => {
        if (this.state === "idle") this.dial()
      },
      backoffDelay(this.redials++, REDIAL_BACKOFF)
    )
  }

  /** Resolves every waiting start, or rejects each with `error`. */
  private settle(error?: Error) {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const waiter of waiters)
      if (error) waiter.reject(error)
      else waiter.resolve()
  }

  private sanitizeRequestError(
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
      dispatch.requestSent,
      dispatch.accepted
    )
  }

  private async stopClient() {
    this.state = "stopped"
    clearTimeout(this.redial)
    this.settle(new OpenClawClientUnavailableError())
    try {
      await this.gateway.stopAndWait()
    } catch {
      // Gateway close failures do not expose native detail and cannot revive the client.
    }
  }
}
