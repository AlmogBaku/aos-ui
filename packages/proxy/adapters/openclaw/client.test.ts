import { describe, expect, it, vi } from "vitest"
import { GatewayClientRequestError } from "@openclaw/gateway-client"

import { useFakeClock } from "../../../../test/support/fake-clock"
import {
  OpenClawClient,
  OpenClawClientConnectionError,
  OpenClawClientRequestError,
  OpenClawClientUnavailableError,
  type OpenClawGatewayClient,
  type OpenClawGatewayClientOptions,
  type OpenClawRequestOptions,
} from "./client"

class ControlledGatewayClient implements OpenClawGatewayClient {
  readonly requests: {
    method: string
    params: unknown
    options: OpenClawRequestOptions | undefined
  }[] = []
  readonly start = vi.fn()
  readonly stopAndWait = vi.fn(async () => undefined)
  requestResult: unknown = { ok: true }
  requestError: unknown
  requestHandler?: <T>(
    options: OpenClawRequestOptions | undefined
  ) => Promise<T>

  constructor(readonly options: OpenClawGatewayClientOptions) {}

  request<T>(
    method: string,
    params?: unknown,
    options?: OpenClawRequestOptions
  ) {
    this.requests.push({ method, params, options })
    if (this.requestHandler) return this.requestHandler<T>(options)
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
      url: "wss://gateway.example.test",
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

  it("re-reads validated negotiated attachment limits from every HelloOk", async () => {
    const onReady = vi.fn()
    const { client, gateway } = setup({ onReady })
    const started = client.start()

    gateway().options.onHelloOk?.({
      protocol: 4,
      policy: {
        maxPayload: 30 * 1024 * 1024,
        attachments: {
          maxBytes: 25 * 1024 * 1024,
          maxImageBytes: 10 * 1024 * 1024,
        },
      },
      providerPrivate: "must-not-escape",
    } as never)

    await expect(started).resolves.toBeUndefined()
    expect(client.negotiatedPolicy()).toEqual({
      maxPayload: 30 * 1024 * 1024,
      attachments: {
        maxBytes: 25 * 1024 * 1024,
        maxImageBytes: 10 * 1024 * 1024,
      },
    })

    gateway().options.onHelloOk?.({
      protocol: 4,
      policy: { maxPayload: 1024 },
    } as never)

    expect(client.negotiatedPolicy()).toEqual({ maxPayload: 1024 })
    expect(onReady).toHaveBeenCalledTimes(2)
  })

  it("does not manufacture attachment policy from missing or malformed HelloOk policy", async () => {
    for (const hello of [
      { protocol: 4 },
      { protocol: 4, policy: { maxPayload: -1, attachments: { maxBytes: 1 } } },
    ]) {
      const { client, gateway } = setup()
      const started = client.start()

      gateway().options.onHelloOk?.(hello as never)

      await expect(started).resolves.toBeUndefined()
      expect(client.negotiatedPolicy()).toBeUndefined()
    }
  })

  it("fails closed when a Gateway reports a protocol other than v4", async () => {
    const { client, gateway } = setup()
    const started = client.start()

    gateway().options.onHelloOk?.({ protocol: 3 } as never)

    await expect(started).rejects.toEqual(
      new OpenClawClientConnectionError("authentication")
    )
  })

  it("rejects a pairing-rejected start without native detail and never caches it", async () => {
    const { client, gateway } = setup()
    const first = client.start()

    gateway().options.onConnectError?.(
      new GatewayClientRequestError({
        message: "pair request pair-123 token=pre-provisioned-token",
        details: { code: "PAIRING_REQUIRED", requestId: "pair-123" },
      })
    )

    await expect(first).rejects.toEqual(
      new OpenClawClientConnectionError("pairing-required")
    )
    await expect(client.request("sessions.list", {})).rejects.toEqual(
      new OpenClawClientUnavailableError()
    )
    const second = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)

    await expect(second).resolves.toBeUndefined()
    expect(gateway().stopAndWait).not.toHaveBeenCalled()
  })

  it("keeps readiness usable through a transient transport failure until the Gateway reconnects", async () => {
    const onConnectionIssue = vi.fn()
    const { client, gateway } = setup({ onConnectionIssue })
    const started = client.start()

    gateway().options.onConnectError?.(
      new Error("wss://gateway.example.test token=pre-provisioned-token")
    )
    expect(gateway().stopAndWait).not.toHaveBeenCalled()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)

    await expect(started).resolves.toBeUndefined()
    expect(onConnectionIssue).toHaveBeenCalledWith({
      kind: "unavailable",
      terminal: false,
    })
  })

  it("keeps readiness usable when pairing explicitly asks the client to retry", async () => {
    const onConnectionIssue = vi.fn()
    const { client, gateway } = setup({ onConnectionIssue })
    const started = client.start()

    gateway().options.onConnectError?.(
      new GatewayClientRequestError({
        details: {
          code: "PAIRING_REQUIRED",
          pauseReconnect: false,
          recommendedNextStep: "wait_then_retry",
        },
      })
    )
    gateway().options.onHelloOk?.({ protocol: 4 } as never)

    await expect(started).resolves.toBeUndefined()
    expect(gateway().stopAndWait).not.toHaveBeenCalled()
    expect(onConnectionIssue).toHaveBeenCalledWith({
      kind: "pairing-required",
      terminal: false,
    })
  })

  it.each([
    ["AUTH_UNAUTHORIZED", "authentication"],
    ["AUTH_DEVICE_TOKEN_MISMATCH", "credential-rejected"],
    ["AUTH_SCOPE_MISMATCH", "scope-mismatch"],
    ["AUTH_RATE_LIMITED", "rate-limited"],
  ] as const)(
    "classifies structured %s startup rejection as %s",
    async (code, kind) => {
      const { client, gateway } = setup()
      const started = client.start()

      gateway().options.onConnectError?.(
        new GatewayClientRequestError({ details: { code } })
      )

      await expect(started).rejects.toEqual(
        new OpenClawClientConnectionError(kind)
      )
    }
  )

  it("aborts a ready Gateway request on the caller's cancellation or the 15 s call deadline", async () => {
    const clock = useFakeClock()
    const { client, gateway } = setup()
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started
    gateway().requestHandler = (options) =>
      new Promise((_resolve, reject) => {
        options?.onSent?.()
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("native abort detail"))
        )
      })
    const controller = new AbortController()

    const cancelled = client.request(
      "sessions.list",
      {},
      { signal: controller.signal }
    )
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({
      kind: "cancelled",
      requestSent: true,
    })
    const timedOut = expect(
      client.request("sessions.list", {})
    ).rejects.toMatchObject({
      kind: "timeout",
      requestSent: true,
      uncertain: true,
    })
    await clock.advance(15_000)
    await timedOut
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

  it("preserves a dispatched cancellation as uncertain without replaying it", async () => {
    const { client, gateway } = setup()
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started
    const controller = new AbortController()
    gateway().requestHandler = (options) => {
      options?.onSent?.()
      controller.abort()
      return Promise.reject(new Error("native cancellation detail"))
    }

    await expect(
      client.request(
        "chat.send",
        { text: "once" },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({
      kind: "cancelled",
      requestSent: true,
      uncertain: true,
    })
  })

  it("preserves official sent and accepted acknowledgement boundaries for a leaf", async () => {
    const { client, gateway } = setup()
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started
    const onSent = vi.fn()
    const onAccepted = vi.fn()
    gateway().requestHandler = async (options) => {
      options?.onSent?.()
      options?.onAccepted?.({ id: "native-ack" })
      return { accepted: true }
    }

    await expect(
      client.request("chat.send", { text: "once" }, { onSent, onAccepted })
    ).resolves.toEqual({ accepted: true })
    expect(onSent).toHaveBeenCalledOnce()
    expect(onAccepted).toHaveBeenCalledWith({ id: "native-ack" })
  })

  it("keeps an accepted request pending past the call deadline until its final response when a leaf requires it", async () => {
    const clock = useFakeClock()
    const { client, gateway } = setup()
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started
    const onAccepted = vi.fn()
    let deliverFinal: ((payload: { status: "final" }) => void) | undefined
    gateway().requestHandler = (options) =>
      new Promise((resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        )
        options?.onSent?.()
        if (options?.expectFinal) {
          options.onAccepted?.({ status: "accepted" })
          deliverFinal = (payload) => resolve(payload)
          return
        }
        resolve({ status: "accepted" })
      })

    const request = client.request(
      "chat.send",
      { text: "once" },
      { expectFinal: true, onAccepted }
    )
    expect(onAccepted).toHaveBeenCalledWith({ status: "accepted" })
    let settled = false
    void request.then(() => {
      settled = true
    })
    await clock.advance(15_000)
    expect(settled).toBe(false)

    deliverFinal?.({ status: "final" })
    await expect(request).resolves.toEqual({ status: "final" })
  })

  it("forwards paused and closed transport state without native close detail, then redials", async () => {
    const clock = useFakeClock()
    const onReconnectPaused = vi.fn()
    const onClose = vi.fn()
    const { client, gateway } = setup({ onReconnectPaused, onClose })
    const started = client.start()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)
    await started

    gateway().options.onReconnectPaused?.({
      code: 1008,
      reason: "token=pre-provisioned-token",
      detailCode: "AUTH_RATE_LIMITED",
    })
    gateway().options.onClose?.(1008, "token=pre-provisioned-token", {
      phase: "post-hello",
    } as never)

    expect(onReconnectPaused).toHaveBeenCalledWith({
      kind: "rate-limited",
      terminal: true,
    })
    expect(onClose).toHaveBeenCalledWith({
      phase: "post-hello",
      recoverable: true,
    })
    await clock.advance(1_000)
    expect(gateway().start).toHaveBeenCalledTimes(2)
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
