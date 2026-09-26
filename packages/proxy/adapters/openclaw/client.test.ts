import { describe, expect, it, vi } from "vitest"
import { GatewayClientRequestError } from "@openclaw/gateway-client"

import { useFakeClock } from "../../../../test/support/fake-clock"
import { captureLogs } from "../../../../test/support/log-capture"
import {
  OpenClawClient,
  OpenClawClientConnectionError,
  OpenClawClientUnavailableError,
  type OpenClawClientCredentials,
  type OpenClawClientOptions,
  type OpenClawGatewayClient,
  type OpenClawGatewayClientOptions,
  type OpenClawRequestOptions,
} from "./client"

vi.mock("@openclaw/gateway-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@openclaw/gateway-client")>()
  return {
    ...actual,
    // The official client marks every Gateway answer it builds; here a
    // stub's GatewayClientRequestError stands for one.
    isGatewayProtocolResponseError: (error: unknown) =>
      error instanceof actual.GatewayClientRequestError,
  }
})

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

const credentials = (
  deviceToken = "tok-test-1"
): OpenClawClientCredentials => ({
  deviceIdentity: {
    deviceId: "device-a",
    privateKeyPem: "private-key",
    publicKeyPem: "public-key",
  },
  deviceToken,
  signDevicePayload: () => "signature",
  publicKeyRawBase64UrlFromPem: () => "public-key-raw",
})

/** A client whose link has dialed once: `gateway()` is the latest dial's. */
async function setup(
  clock: ReturnType<typeof useFakeClock>,
  overrides?: Partial<OpenClawClientOptions>
) {
  const gateways: ControlledGatewayClient[] = []
  const client = new OpenClawClient({
    url: "wss://gateway.example.test",
    credentials: async () => credentials(),
    role: "aos-operator",
    scopes: ["sessions.read", "sessions.write"],
    caps: ["tool-events"],
    logger: captureLogs().logger,
    createGatewayClient: (options) => {
      const gateway = new ControlledGatewayClient(options)
      gateways.push(gateway)
      return gateway
    },
    ...overrides,
  })
  await clock.advance(0)
  return {
    client,
    gateways,
    gateway: () => {
      const gateway = gateways.at(-1)
      if (!gateway) throw new Error("Gateway client was not created")
      return gateway
    },
  }
}

/** A client whose link is up. */
async function ready(
  clock: ReturnType<typeof useFakeClock>,
  overrides?: Partial<OpenClawClientOptions>
) {
  const setUp = await setup(clock, overrides)
  const started = setUp.client.start()
  setUp.gateway().options.onHelloOk?.({ protocol: 4 } as never)
  await started
  return setUp
}

describe("OpenClaw client", () => {
  it("fails closed without a gateway while a pre-provisioned device token is missing, and at once while the breaker holds its dials", async () => {
    const clock = useFakeClock()
    const { client, gateways } = await setup(clock, {
      credentials: async () => credentials(""),
    })

    const started = expect(client.start()).rejects.toEqual(
      new OpenClawClientConnectionError("unavailable")
    )
    await clock.advance(250)
    await started
    expect(gateways).toHaveLength(0)

    // Five failed dials open the breaker: a start does not wait out its deadline.
    await clock.advance(5_000)
    await expect(client.start()).rejects.toEqual(
      new OpenClawClientConnectionError("unavailable")
    )
  })

  it("starts one exact-v4 Gateway connection with the configured server credentials and policy", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await setup(clock)
    const started = client.start()
    const native = gateway()

    expect(native.start).toHaveBeenCalledOnce()
    expect(native.options).toMatchObject({
      url: "wss://gateway.example.test",
      deviceToken: "tok-test-1",
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

  it("reads validated negotiated attachment limits from the HelloOk", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await setup(clock)
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
  })

  it("does not manufacture attachment policy from missing or malformed HelloOk policy", async () => {
    const clock = useFakeClock()
    for (const hello of [
      { protocol: 4 },
      { protocol: 4, policy: { maxPayload: -1, attachments: { maxBytes: 1 } } },
    ]) {
      const { client, gateway } = await setup(clock)
      const started = client.start()

      gateway().options.onHelloOk?.(hello as never)

      await expect(started).resolves.toBeUndefined()
      expect(client.negotiatedPolicy()).toBeUndefined()
    }
  })

  it("fails closed when a Gateway reports a protocol other than v4", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await setup(clock)
    const started = client.start()

    gateway().options.onHelloOk?.({ protocol: 3 } as never)

    await expect(started).rejects.toEqual(
      new OpenClawClientConnectionError("authentication")
    )
  })

  it("stops dialing on a pairing refusal, its native detail only a cause, and dials again for the next start", async () => {
    const clock = useFakeClock()
    const { client, gateway, gateways } = await setup(clock)
    const first = client.start()
    const refusal = new GatewayClientRequestError({
      message: "pair request pair-123 token=tok-test-1",
      details: { code: "PAIRING_REQUIRED", requestId: "pair-123" },
    })

    gateway().options.onConnectError?.(refusal)

    await expect(first).rejects.toEqual(
      new OpenClawClientConnectionError("pairing-required", { cause: refusal })
    )
    await expect(client.request("sessions.list", {})).rejects.toEqual(
      new OpenClawClientConnectionError("pairing-required")
    )
    await clock.advance(60_000)
    expect(gateways).toHaveLength(1)
    expect(client.link.state()).toBe("lost")

    const second = client.start()
    await clock.advance(0)
    gateway().options.onHelloOk?.({ protocol: 4 } as never)

    await expect(second).resolves.toBeUndefined()
    expect(gateways).toHaveLength(2)
    expect(gateways[0]!.stopAndWait).toHaveBeenCalledOnce()
  })

  it("keeps readiness usable through a transient transport failure until the Gateway reconnects", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await setup(clock)
    const started = client.start()

    gateway().options.onConnectError?.(
      new Error("wss://gateway.example.test token=tok-test-1")
    )
    expect(gateway().stopAndWait).not.toHaveBeenCalled()
    gateway().options.onHelloOk?.({ protocol: 4 } as never)

    await expect(started).resolves.toBeUndefined()
  })

  it("keeps readiness usable when pairing explicitly asks the client to retry", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await setup(clock)
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
  })

  it.each([
    ["AUTH_UNAUTHORIZED", "authentication"],
    ["AUTH_DEVICE_TOKEN_MISMATCH", "credential-rejected"],
    ["AUTH_SCOPE_MISMATCH", "scope-mismatch"],
    ["AUTH_RATE_LIMITED", "rate-limited"],
  ] as const)(
    "classifies structured %s startup rejection as %s",
    async (code, kind) => {
      const clock = useFakeClock()
      const { client, gateway } = await setup(clock)
      const started = client.start()

      gateway().options.onConnectError?.(
        new GatewayClientRequestError({ details: { code } })
      )

      await expect(started).rejects.toEqual(
        new OpenClawClientConnectionError(kind)
      )
    }
  )

  it("aborts a ready Gateway read on the caller's cancellation or the 15 s call deadline, never uncertain", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await ready(clock)
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
      uncertain: false,
    })
    const timedOut = expect(
      client.request("sessions.list", {})
    ).rejects.toMatchObject({
      kind: "timeout",
      uncertain: false,
    })
    await clock.advance(15_000)
    await timedOut
  })

  it("keeps a native request failure's detail out of its message, as its cause", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await ready(clock)
    const native = new Error("native /private/path token=tok-test-1")
    gateway().requestError = native

    await expect(client.request("sessions.list", {})).rejects.toMatchObject({
      kind: "unavailable",
      cause: native,
    })
    await expect(client.request("sessions.list", {})).rejects.not.toThrow(
      "native /private/path token=tok-test-1"
    )
  })

  it("leaves a dispatched write uncertain unless the Gateway refused it", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await ready(clock)
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
      uncertain: true,
    })

    gateway().requestHandler = (options) => {
      options?.onSent?.()
      return Promise.reject(
        new GatewayClientRequestError({ code: "INVALID_REQUEST" })
      )
    }
    await expect(
      client.request("chat.send", { text: "once" })
    ).rejects.toMatchObject({ kind: "rejected", uncertain: false })
  })

  it("preserves official sent and accepted acknowledgement boundaries for a leaf", async () => {
    const clock = useFakeClock()
    const { client, gateway } = await ready(clock)
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
    const { client, gateway } = await ready(clock)
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

  it.each([
    ["closes", undefined, "unavailable"],
    ["pauses its reconnect", "AUTH_RATE_LIMITED", "rate-limited"],
  ] as const)(
    "reads lost while a Gateway that %s is down, then redials on a re-read token and new limits",
    async (_, pausedOn, kind) => {
      let token = "tok-test-1"
      const clock = useFakeClock()
      const { client, gateway, gateways } = await ready(clock, {
        credentials: async () => credentials(token),
      })
      token = "tok-test-2"

      // The official client reports a pause before the close it follows.
      if (pausedOn)
        gateway().options.onReconnectPaused?.({
          code: 1008,
          reason: "token=tok-test-1",
          detailCode: pausedOn,
        })
      gateway().options.onClose?.(1006, "token=tok-test-1", {
        phase: "post-hello",
      } as never)

      expect(client.link.state()).toBe("lost")
      await expect(client.request("sessions.list", {})).rejects.toEqual(
        new OpenClawClientConnectionError(kind)
      )
      expect(gateways[0]!.stopAndWait).toHaveBeenCalledOnce()
      await clock.advance(250)
      expect(gateway().options.deviceToken).toBe("tok-test-2")
      gateway().options.onHelloOk?.({
        protocol: 4,
        policy: { maxPayload: 1024 },
      } as never)
      await clock.advance(0)

      expect(client.link.state()).toBe("ready")
      expect(client.negotiatedPolicy()).toEqual({ maxPayload: 1024 })
    }
  )

  it("forwards the live Gateway's event and gap notifications, drops a released one's, and stops idempotently", async () => {
    const onEvent = vi.fn()
    const onGap = vi.fn()
    const clock = useFakeClock()
    const { client, gateway } = await ready(clock, { onEvent, onGap })

    const event = { event: "chat", payload: { sessionKey: "agent:a:main" } }
    gateway().options.onEvent?.(event as never)
    gateway().options.onGap?.({ expected: 4, received: 7 })
    await Promise.all([client.stopAndWait(), client.stopAndWait()])
    gateway().options.onEvent?.(event as never)

    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith(event)
    expect(onGap).toHaveBeenCalledWith({ expected: 4, received: 7 })
    expect(gateway().stopAndWait).toHaveBeenCalledOnce()
    await expect(client.start()).rejects.toEqual(
      new OpenClawClientUnavailableError()
    )
  })
})
