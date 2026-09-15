import {
  GatewayClient,
  GatewayClientRequestTimeoutError,
  isGatewayProtocolResponseError,
  type DeviceIdentity,
  type GatewayClientOptions,
} from "@openclaw/gateway-client"
import {
  PROTOCOL_VERSION,
  type EventFrame,
  type HelloOk,
} from "@openclaw/gateway-protocol"

type GatewayRequestOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: number | null
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
  | "onEvent"
  | "onGap"
  | "onHelloOk"
  | "requestTimeoutMs"
  | "role"
  | "scopes"
  | "url"
>

/** The small official-client surface needed before provider operations exist. */
export interface OpenClawGatewayClient {
  start(): void
  stopAndWait(options?: { timeoutMs?: number }): Promise<void>
  request<T>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions
  ): Promise<T>
}

/** Credentials are provisioned by server composition; this client never pairs or persists them. */
export type OpenClawClientCredentials = Readonly<{
  deviceIdentity: DeviceIdentity
  deviceToken: string
  signDevicePayload: (privateKeyPem: string, payload: string) => string
  publicKeyRawBase64UrlFromPem: (publicKeyPem: string) => string
}>

export type OpenClawClientOptions = Readonly<{
  url: string
  credentials: OpenClawClientCredentials
  role: string
  scopes: readonly string[]
  caps: readonly string[]
  requestTimeoutMs?: number
  onEvent?: (event: EventFrame) => void
  onGap?: (gap: Readonly<{ expected: number; received: number }>) => void
  createGatewayClient?: (
    options: OpenClawGatewayClientOptions
  ) => OpenClawGatewayClient
}>

export class OpenClawClientAuthenticationError extends Error {
  constructor() {
    super("OpenClaw authentication failed")
    this.name = "OpenClawClientAuthenticationError"
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
    readonly kind: "cancelled" | "rejected" | "timeout" | "unavailable"
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

type ClientState =
  "new" | "starting" | "ready" | "failed" | "stopping" | "stopped"

export class OpenClawClient {
  private state: ClientState = "new"
  private readonly gateway: OpenClawGatewayClient
  private readonly requestTimeout?: number
  private ready?: Promise<void>
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
      onConnectError: () => this.rejectAuthentication(),
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
      this.rejectAuthentication()
    }
    return this.ready
  }

  async request<T>(
    method: string,
    params?: unknown,
    options: GatewayRequestOptions = {}
  ): Promise<T> {
    if (this.state !== "ready") throw new OpenClawClientUnavailableError()
    if (options.signal?.aborted)
      throw new OpenClawClientRequestError("cancelled")
    try {
      return await this.gateway.request<T>(method, params, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.requestTimeout,
      })
    } catch (error) {
      throw this.sanitizeRequestError(error, options.signal)
    }
  }

  stopAndWait(): Promise<void> {
    if (this.stop) return this.stop
    this.stop = this.stopClient()
    return this.stop
  }

  private acceptHello(hello: HelloOk) {
    if (this.state !== "starting") return
    if (hello.protocol !== PROTOCOL_VERSION) {
      this.rejectAuthentication()
      return
    }
    this.state = "ready"
    this.resolveReady?.()
  }

  private rejectAuthentication() {
    if (this.state !== "starting") return
    this.state = "failed"
    this.rejectReady?.(new OpenClawClientAuthenticationError())
  }

  private sanitizeRequestError(
    error: unknown,
    signal: AbortSignal | undefined
  ) {
    if (signal?.aborted) return new OpenClawClientRequestError("cancelled")
    if (error instanceof GatewayClientRequestTimeoutError)
      return new OpenClawClientRequestError("timeout")
    if (isGatewayProtocolResponseError(error))
      return new OpenClawClientRequestError("rejected")
    return new OpenClawClientRequestError("unavailable")
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
