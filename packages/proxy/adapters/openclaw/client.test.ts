import { describe, expect, it, vi } from "vitest"
import { GatewayClientRequestTimeoutError } from "@openclaw/gateway-client"

import {
  OpenClawClient,
  OpenClawClientAuthenticationError,
  OpenClawClientRequestError,
  OpenClawClientUnavailableError,
  type OpenClawGatewayClient,
  type OpenClawGatewayClientOptions,
} from "./client"

class ControlledGatewayClient implements OpenClawGatewayClient {
  readonly requests: {
    method: string
    params: unknown
    options: { signal?: AbortSignal; timeoutMs?: number | null } | undefined
  }[] = []
  readonly start = vi.fn()
  readonly stopAndWait = vi.fn(async () => undefined)
  requestResult: unknown = { ok: true }
  requestError: unknown

  constructor(readonly options: OpenClawGatewayClientOptions) {}

  request<T>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number | null }
  ) {
    this.requests.push({ method, params, options })
    if (this.requestError) return Promise.reject(this.requestError)
    return Promise.resolve(this.requestResult as T)
  }
}

function setup(
  overrides?: Partial<ConstructorParameters<typeof OpenClawClient>[0]>
) {
  let gateway: ControlledGatewayClient | undefined
  const client = new OpenClawClient({
    url: "wss://gateway.example.test",
    credentials: {
      deviceIdentity: {
        deviceId: "device-a",
        privateKeyPem: "private-key",
        publicKeyPem: "public-key",
      },
      deviceToken: "pre-provisioned-token",
      signDevicePayload: () => "signature",
      publicKeyRawBase64UrlFromPem: () => "public-key-raw",
    },
    role: "aos-operator",
    scopes: ["sessions.read", "sessions.write"],
    caps: ["tool-events"],
    createGatewayClient: (options) =>
      (gateway = new ControlledGatewayClient(options)),
    ...overrides,
  })
  return {
    client,
    gateway: () => {
      if (!gateway) throw new Error("Gateway client was not created")
      return gateway
    },
  }
}

describe("OpenClaw client", () => {
  it("rejects a mutable or non-WebSocket gateway URL before accepting credentials", () => {
    expect(
      () =>
        new OpenClawClient({
          url: "https://gateway.example.test?token=leaked",
          credentials: {
            deviceIdentity: {
              deviceId: "device-a",
              privateKeyPem: "private-key",
              publicKeyPem: "public-key",
            },
            deviceToken: "pre-provisioned-token",
            signDevicePayload: () => "signature",
            publicKeyRawBase64UrlFromPem: () => "public-key-raw",
          },
          role: "aos-operator",
          scopes: ["sessions.read"],
          caps: [],
        })
    ).toThrow("Invalid OpenClaw Gateway URL")
  })

  it("fails closed when a pre-provisioned device token is missing", () => {
    expect(() => setup({ credentials: undefined })).toThrow(
      "Invalid OpenClaw credentials"
    )
  })

  it("starts one exact-v4 Gateway connection with the configured server credentials and policy", async () => {
    const { client, gateway } = setup()
    const started = client.start()
    const native = gateway()

    expect(native.start).toHaveBeenCalledOnce()
    expect(native.options).toMatchObject({
      url: "wss://gateway.example.test/",
      deviceToken: "pre-provisioned-token",
      minProtocol: 4,
      maxProtocol: 4,
      mode: "backend",
      role: "aos-operator",
      scopes: ["sessions.read", "sessions.write"],
      caps: ["tool-events"],
    })
    expect(native.options.bootstrapToken).toBeUndefined()
    expect(native.options.token).toBeUndefined()
    native.options.onHelloOk?.({ protocol: 4 } as never)

    await expect(started).resolves.toBeUndefined()
  })

  it("fails closed when a Gateway reports a protocol other than v4", async () => {
    const { client, gateway } = setup()
    const started = client.start()

    gateway().options.onHelloOk?.({ protocol: 3 } as never)

    await expect(started).rejects.toEqual(
      new OpenClawClientAuthenticationError()
    )
  })

  it("fails closed when the Gateway rejects the pre-provisioned credentials", async () => {
    const { client, gateway } = setup()
    const started = client.start()

    gateway().options.onConnectError?.(new Error("token=pre-provisioned-token"))

    await expect(started).rejects.toEqual(
      new OpenClawClientAuthenticationError()
    )
    await expect(client.request("sessions.list", {})).rejects.toEqual(
      new OpenClawClientUnavailableError()
    )
  })

  it("passes the caller cancellation and bounded deadline to a ready Gateway request", async () => {
    const { client, gateway } = setup({ requestTimeoutMs: 321 })
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started
    const controller = new AbortController()

    await expect(
      client.request(
        "sessions.list",
        { limit: 3 },
        { signal: controller.signal }
      )
    ).resolves.toEqual({ ok: true })
    expect(gateway().requests).toEqual([
      {
        method: "sessions.list",
        params: { limit: 3 },
        options: { signal: controller.signal, timeoutMs: 321 },
      },
    ])
  })

  it("sanitizes native request failures without preserving native error detail", async () => {
    const { client, gateway } = setup()
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started
    gateway().requestError = new Error("native /private/path token=secret")

    await expect(client.request("sessions.list", {})).rejects.toEqual(
      new OpenClawClientRequestError("unavailable")
    )
    await expect(client.request("sessions.list", {})).rejects.not.toThrow(
      "native /private/path token=secret"
    )
  })

  it("sanitizes an official request timeout without exposing its method or timeout", async () => {
    const { client, gateway } = setup()
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started
    gateway().requestError = new GatewayClientRequestTimeoutError({
      method: "sessions.list",
      timeoutMs: 321,
      requestSent: true,
    })

    await expect(client.request("sessions.list", {})).rejects.toEqual(
      new OpenClawClientRequestError("timeout")
    )
  })

  it("forwards event and gap notifications to server observers and stops idempotently", async () => {
    const onEvent = vi.fn()
    const onGap = vi.fn()
    const { client, gateway } = setup({ onEvent, onGap })
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started

    const event = { event: "chat", payload: { sessionKey: "agent:a:main" } }
    gateway().options.onEvent?.(event as never)
    gateway().options.onGap?.({ expected: 4, received: 7 })
    await Promise.all([client.stopAndWait(), client.stopAndWait()])

    expect(onEvent).toHaveBeenCalledWith(event)
    expect(onGap).toHaveBeenCalledWith({ expected: 4, received: 7 })
    expect(gateway().stopAndWait).toHaveBeenCalledOnce()
  })
})
