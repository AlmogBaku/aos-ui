import {
  GatewayClient,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
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

export type OpenClawRequestOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: number | null
  expectFinal?: boolean
  onSent?: () => void
  onAccepted?: (payload: unknown) => void
}>

/** The only HelloOk data that later provider leaves may consume. */
export type OpenClawNegotiatedPolicy = Readonly<{
  maxPayload: number
  attachments: Readonly<{
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
  | "requestTimeoutMs"
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
  requestTimeoutMs?: number
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

function fixedGatewayUrl(value: string) {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== "ws:" && url.protocol !== "wss:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.href
  } catch {
    throw new Error("Invalid OpenClaw Gateway URL")
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
    !policy?.attachments ||
    !Number.isSafeInteger(policy.maxPayload) ||
    policy.maxPayload < 1 ||
    !Number.isSafeInteger(policy.attachments.maxBytes) ||
    policy.attachments.maxBytes < 1 ||
    !Number.isSafeInteger(policy.attachments.maxImageBytes) ||
    policy.attachments.maxImageBytes < 1
  )
    return undefined
  return Object.freeze({
    maxPayload: policy.maxPayload,
    attachments: Object.freeze({
      maxBytes: policy.attachments.maxBytes,
      maxImageBytes: policy.attachments.maxImageBytes,
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

type ClientState =
  "new" | "starting" | "ready" | "terminal" | "stopping" | "stopped"

export class OpenClawClient {
  private state: ClientState = "new"
  private readonly gateway: OpenClawGatewayClient
  private readonly requestTimeout?: number
  private ready?: Promise<void>
  private policy?: OpenClawNegotiatedPolicy
  private resolveReady?: () => void
  private rejectReady?: (error: Error) => void
  private stop?: Promise<void>

  constructor(options: OpenClawClientOptions) {
    const url = fixedGatewayUrl(options.url)
    validateCredentials(options.credentials)
    if (
      !validNonEmptyString(options.role) ||
      !validStringList(options.scopes, true) ||
      !validStringList(options.caps)
    )
      throw new Error("Invalid OpenClaw connection policy")
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestTimeoutMs) ||
        options.requestTimeoutMs < 1)
    )
      throw new Error("Invalid OpenClaw request timeout")
    this.requestTimeout = options.requestTimeoutMs

    const gatewayOptions: OpenClawGatewayClientOptions = {
      url,
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
      requestTimeoutMs: options.requestTimeoutMs,
      onHelloOk: (hello) => this.acceptHello(hello),
      onConnectError: (error) => this.handleConnectError(error, options),
      onReconnectPaused: (info) => {
        const issue = connectionIssue({ details: { code: info.detailCode } })
        options.onReconnectPaused?.({ ...issue, terminal: true })
      },
      onClose: (_code, _reason, info) =>
        options.onClose?.({
          phase: info?.phase ?? "pre-hello",
          recoverable: this.state === "starting" || this.state === "ready",
        }),
      onEvent: (event) => options.onEvent?.(event),
      onGap: (gap) => options.onGap?.(gap),
    }
    this.gateway =
      options.createGatewayClient?.(gatewayOptions) ??
      new GatewayClient(gatewayOptions)
  }

  start(): Promise<void> {
    if (this.state === "ready") return Promise.resolve()
    if (this.state === "starting") return this.ready!
    if (this.state !== "new")
      return Promise.reject(new OpenClawClientUnavailableError())

    this.state = "starting"
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    try {
      this.gateway.start()
    } catch {
      this.rejectTerminal(new OpenClawClientConnectionError("unavailable"))
    }
    return this.ready
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
    try {
      /** Each provider leaf validates its exact method params and result before conversion. */
      return await this.gateway.request<T>(method, params, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.requestTimeout,
        expectFinal: options.expectFinal,
        onSent: () => {
          dispatch.requestSent = true
          options.onSent?.()
        },
        onAccepted: (payload) => {
          dispatch.accepted = true
          options.onAccepted?.(payload)
        },
      })
    } catch (error) {
      throw this.sanitizeRequestError(error, options.signal, dispatch)
    }
  }

  stopAndWait(): Promise<void> {
    if (this.stop) return this.stop
    this.stop = this.stopClient()
    return this.stop
  }

  negotiatedPolicy() {
    return this.policy
  }

  private acceptHello(hello: HelloOk) {
    if (this.state !== "starting") return
    if (hello.protocol !== PROTOCOL_VERSION) {
      this.rejectTerminal(new OpenClawClientConnectionError("authentication"))
      return
    }
    this.policy = negotiatedPolicy(hello)
    this.state = "ready"
    this.resolveReady?.()
  }

  private handleConnectError(error: unknown, options: OpenClawClientOptions) {
    const issue = connectionIssue(error)
    options.onConnectionIssue?.(issue)
    if (issue.terminal)
      this.rejectTerminal(new OpenClawClientConnectionError(issue.kind))
  }

  private rejectTerminal(error: OpenClawClientConnectionError) {
    if (this.state !== "starting" && this.state !== "ready") return
    const wasStarting = this.state === "starting"
    this.state = "terminal"
    if (wasStarting) this.rejectReady?.(error)
    this.stop ??= this.disposeTerminal()
  }

  private sanitizeRequestError(
    error: unknown,
    signal: AbortSignal | undefined,
    dispatch: Readonly<{ accepted: boolean; requestSent: boolean }>
  ) {
    const timeoutSent =
      error instanceof GatewayClientRequestTimeoutError && error.requestSent
    const requestSent = dispatch.requestSent || timeoutSent
    if (signal?.aborted)
      return new OpenClawClientRequestError(
        "cancelled",
        requestSent,
        dispatch.accepted
      )
    if (error instanceof GatewayClientRequestTimeoutError)
      return new OpenClawClientRequestError(
        "timeout",
        requestSent,
        dispatch.accepted
      )
    if (isGatewayProtocolResponseError(error))
      return new OpenClawClientRequestError(
        "rejected",
        requestSent,
        dispatch.accepted
      )
    return new OpenClawClientRequestError(
      "unavailable",
      requestSent,
      dispatch.accepted
    )
  }

  private async disposeTerminal() {
    try {
      await this.gateway.stopAndWait()
    } catch {
      // A terminal connection rejection is already reported without native detail.
    } finally {
      this.state = "stopped"
    }
  }

  private async stopClient() {
    if (this.state === "starting") {
      this.state = "stopping"
      this.rejectReady?.(new OpenClawClientUnavailableError())
    } else if (this.state !== "stopped") this.state = "stopping"
    try {
      await this.gateway.stopAndWait()
    } catch {
      // Gateway close failures do not expose native detail and cannot revive the client.
    } finally {
      this.state = "stopped"
    }
  }
}
