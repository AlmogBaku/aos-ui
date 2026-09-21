import { afterEach, describe, expect, it, vi } from "vitest"

import { OPEN_MESSAGE_TYPE, type PushRegistration } from "@aos/protocol/push"
import { defaultBrowserPreferences } from "./policy"
import {
  createBrowserPushPlatform,
  createPushSubscriptionManager,
  decodeApplicationServerKey,
  type PushClient,
  type PushPlatform,
  type PushSubscriptionLike,
} from "./push-subscription"

const PUBLIC_KEY = "k".repeat(87)
const registration = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
})

function fakeSubscription(endpoint: string): PushSubscriptionLike & {
  unsubscribe: ReturnType<typeof vi.fn>
} {
  return {
    endpoint,
    toJSON: () => registration(endpoint),
    unsubscribe: vi.fn(async () => true),
  }
}

function setup(
  options: {
    info?: Awaited<ReturnType<PushClient["pushInfo"]>> | "failure"
    supported?: boolean
    secureContext?: boolean
    subscription?: PushSubscriptionLike | null
    registrationReady?: boolean
  } = {}
) {
  let current = options.subscription ?? null
  let message: ((data: unknown) => void) | undefined
  const pushInfo = vi.fn(async () => {
    if (options.info === "failure") throw new Error("offline")
    return (
      options.info ?? { status: "available" as const, publicKey: PUBLIC_KEY }
    )
  })
  const putPushSubscription = vi.fn<(body: PushRegistration) => Promise<void>>(
    async () => {}
  )
  const deletePushSubscription = vi.fn<(endpoint: string) => Promise<void>>(
    async () => {}
  )
  const register = vi.fn(async () => {})
  const subscribe = vi.fn(
    (key: string): Promise<PushSubscriptionLike> | null => {
      subscribed.push(key)
      if (options.registrationReady === false) return null
      const next = fakeSubscription("https://push.example/fresh")
      current = next
      return Promise.resolve(next)
    }
  )
  const subscribed: string[] = []
  const platform: PushPlatform = {
    get supported() {
      return options.supported ?? true
    },
    get secureContext() {
      return options.secureContext ?? true
    },
    register,
    getSubscription: async () => current,
    subscribe,
    onMessage: (listener) => {
      message = listener
      return () => {
        message = undefined
      }
    },
  }
  let clock = 0
  const manager = createPushSubscriptionManager({
    client: { pushInfo, putPushSubscription, deletePushSubscription },
    platform,
    now: () => clock,
  })
  return {
    manager,
    advance: (ms: number) => {
      clock += ms
    },
    pushInfo,
    putPushSubscription,
    deletePushSubscription,
    register,
    subscribe,
    subscribed,
    post: (data: unknown) => message?.(data),
    listening: () => message !== undefined,
    replace: (subscription: PushSubscriptionLike | null) => {
      current = subscription
    },
  }
}

const sync = (
  overrides: {
    enabled?: boolean
    completion?: boolean
    locale?: "en" | "he"
    permission?: "default" | "granted" | "denied" | "unsupported"
  } = {}
) => ({
  permission: overrides.permission ?? ("granted" as const),
  preferences: {
    ...defaultBrowserPreferences,
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
    ...(overrides.completion === undefined
      ? {}
      : { completion: overrides.completion }),
  },
  locale: overrides.locale ?? ("en" as const),
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("what this deployment offers", () => {
  it.each([
    ["unsupported", { supported: false }],
    ["insecure-context", { secureContext: false }],
    ["not-configured", { info: { status: "not-configured" as const } }],
    ["available", {}],
  ])("reports %s", async (expected, options) => {
    const h = setup(options)
    await h.manager.prepare("default")
    expect(h.manager.status()).toBe(expected)
  })

  it("treats a descriptor it cannot read as a deployment without push", async () => {
    const h = setup({ info: "failure" })
    const onChange = vi.fn()
    h.manager.listen({ onChange })

    await h.manager.prepare("default")

    expect(h.manager.status()).toBe("not-configured")
    expect(onChange).toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
  })

  it("asks the proxy and installs the worker once, and never after a refusal", async () => {
    const h = setup()
    await h.manager.prepare("default")
    await h.manager.prepare("granted")
    expect(h.pushInfo).toHaveBeenCalledOnce()
    expect(h.register).toHaveBeenCalledOnce()

    const denied = setup()
    await denied.manager.prepare("denied")
    expect(denied.register).not.toHaveBeenCalled()
    expect(denied.manager.status()).toBe("available")
  })

  it("never installs a worker where push cannot work", async () => {
    const h = setup({ supported: false })
    await h.manager.prepare("granted")
    expect(h.pushInfo).not.toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
  })
})

describe("subscribing from the operator's gesture", () => {
  it("subscribes before any awaited tick and reports the grant", async () => {
    const h = setup()
    await h.manager.prepare("default")

    const answered = h.manager.subscribeFromGesture()
    expect(h.subscribe).toHaveBeenCalledOnce()
    expect(h.subscribed).toEqual([PUBLIC_KEY])
    await expect(answered).resolves.toBe("granted")
  })

  it("reports a refusal and an unready registration apart", async () => {
    const denied = setup()
    await denied.manager.prepare("default")
    denied.subscribe.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("denied"), { name: "NotAllowedError" })
      )
    )
    await expect(denied.manager.subscribeFromGesture()).resolves.toBe("denied")

    const unready = setup({ registrationReady: false })
    await unready.manager.prepare("default")
    await expect(unready.manager.subscribeFromGesture()).resolves.toBe(
      "default"
    )

    // Without a described deployment there is no key to subscribe with.
    const undescribed = setup()
    await expect(undescribed.manager.subscribeFromGesture()).resolves.toBe(
      "default"
    )
    expect(undescribed.subscribe).not.toHaveBeenCalled()
  })
})

describe("keeping the proxy's copy of this device correct", () => {
  it("registers the granted subscription with its locale and categories", async () => {
    const h = setup({
      subscription: fakeSubscription("https://push.example/a"),
    })
    await h.manager.prepare("granted")

    await h.manager.sync(sync({ locale: "he" }))

    expect(h.putPushSubscription).toHaveBeenCalledWith({
      subscription: registration("https://push.example/a"),
      locale: "he",
      categories: { input: true, failure: true, completion: true },
    })
    expect(h.manager.active()).toBe(true)
  })

  it("re-registers a preference change without subscribing again", async () => {
    const h = setup({
      subscription: fakeSubscription("https://push.example/a"),
    })
    await h.manager.prepare("granted")

    await h.manager.sync(sync())
    await h.manager.sync(sync())
    expect(h.putPushSubscription).toHaveBeenCalledOnce()

    await h.manager.sync(sync({ completion: false }))
    expect(h.putPushSubscription).toHaveBeenCalledTimes(2)
    expect(h.putPushSubscription.mock.calls[1]?.[0]).toMatchObject({
      categories: { completion: false },
    })
    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.manager.active()).toBe(true)
  })

  it("retires this device when the operator turns alerts off", async () => {
    const subscription = fakeSubscription("https://push.example/a")
    const h = setup({ subscription })
    await h.manager.prepare("granted")
    await h.manager.sync(sync())

    await h.manager.sync(sync({ enabled: false }))

    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect(h.deletePushSubscription).toHaveBeenCalledWith(
      "https://push.example/a"
    )
    expect(h.manager.active()).toBe(false)
  })

  it("follows a rotated endpoint and retires the one it replaced", async () => {
    const h = setup({
      subscription: fakeSubscription("https://push.example/a"),
    })
    await h.manager.prepare("granted")
    await h.manager.sync(sync())

    h.replace(fakeSubscription("https://push.example/b"))
    await h.manager.sync(sync())

    expect(h.putPushSubscription.mock.calls.at(-1)?.[0]).toMatchObject({
      subscription: registration("https://push.example/b"),
    })
    expect(h.deletePushSubscription).toHaveBeenCalledWith(
      "https://push.example/a"
    )
    expect(h.manager.active()).toBe(true)
  })

  it("leaves OS alerts to the tabs when the proxy refuses the subscription", async () => {
    const h = setup({
      subscription: fakeSubscription("https://push.example/a"),
    })
    h.putPushSubscription.mockRejectedValue(new Error("proxy failure"))
    await h.manager.prepare("granted")

    await expect(h.manager.sync(sync())).resolves.toBeUndefined()
    expect(h.manager.active()).toBe(false)
  })

  it("subscribes this device itself when the browser has already granted", async () => {
    // The live regression: an operator arrives with permission granted, so the
    // ask never appears and nothing else would ever register this device.
    const h = setup()
    await h.manager.prepare("granted")

    await h.manager.sync(sync())

    expect(h.subscribed).toEqual([PUBLIC_KEY])
    expect(h.putPushSubscription).toHaveBeenCalledOnce()
    expect(h.putPushSubscription.mock.calls[0]?.[0]).toMatchObject({
      subscription: registration("https://push.example/fresh"),
      locale: "en",
    })
    expect(h.manager.active()).toBe(true)
  })

  it("replaces a subscription the browser has since dropped", async () => {
    const h = setup({
      subscription: fakeSubscription("https://push.example/a"),
    })
    await h.manager.prepare("granted")
    await h.manager.sync(sync())
    h.replace(null)

    await h.manager.sync(sync())

    expect(h.deletePushSubscription).toHaveBeenCalledWith(
      "https://push.example/a"
    )
    expect(h.subscribed).toEqual([PUBLIC_KEY])
    expect(h.putPushSubscription.mock.calls.at(-1)?.[0]).toMatchObject({
      subscription: registration("https://push.example/fresh"),
    })
    expect(h.manager.active()).toBe(true)
  })

  it("registers nothing when the browser refuses to subscribe", async () => {
    const h = setup()
    h.subscribe.mockImplementation(() =>
      Promise.reject(new Error("subscription refused"))
    )
    const onChange = vi.fn()
    h.manager.listen({ onChange })
    await h.manager.prepare("granted")
    onChange.mockClear()

    await expect(h.manager.sync(sync())).resolves.toBeUndefined()

    expect(h.putPushSubscription).not.toHaveBeenCalled()
    expect(h.manager.active()).toBe(false)
    expect(onChange).toHaveBeenCalled()
  })

  it("leaves a refusing browser alone until the retry window passes", async () => {
    const h = setup()
    h.subscribe.mockImplementation(() =>
      Promise.reject(new Error("subscription refused"))
    )
    await h.manager.prepare("granted")

    await h.manager.sync(sync())
    await h.manager.sync(sync())
    expect(h.subscribe).toHaveBeenCalledOnce()

    h.advance(60_000)
    await h.manager.sync(sync())
    expect(h.subscribe).toHaveBeenCalledTimes(2)
  })

  it("subscribes and registers once across repeated syncs", async () => {
    const h = setup()
    await h.manager.prepare("granted")

    await h.manager.sync(sync())
    await h.manager.sync(sync())

    expect(h.subscribe).toHaveBeenCalledOnce()
    expect(h.putPushSubscription).toHaveBeenCalledOnce()
  })

  it.each(["default", "denied"] as const)(
    "never subscribes on %s permission",
    async (permission) => {
      const h = setup()
      await h.manager.prepare(permission)

      await h.manager.sync(sync({ permission }))

      expect(h.subscribe).not.toHaveBeenCalled()
      expect(h.putPushSubscription).not.toHaveBeenCalled()
    }
  )

  it("never subscribes while the operator keeps alerts switched off", async () => {
    const h = setup()
    await h.manager.prepare("granted")

    await h.manager.sync(sync({ enabled: false }))

    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.putPushSubscription).not.toHaveBeenCalled()
  })

  it("does nothing at all where the deployment offers no push", async () => {
    const h = setup({ info: { status: "not-configured" } })
    await h.manager.prepare("granted")

    await h.manager.sync(sync())

    expect(h.putPushSubscription).not.toHaveBeenCalled()
    expect(h.manager.active()).toBe(false)
  })
})

describe("notification clicks the worker forwards", () => {
  it("opens the named Session, or the workspace when the push carried no ids", () => {
    const h = setup()
    const onOpen = vi.fn()
    const stop = h.manager.listen({ onOpen })

    h.post({ type: OPEN_MESSAGE_TYPE, agentId: "a", sessionId: "t" })
    h.post({ type: OPEN_MESSAGE_TYPE })
    h.post({ type: OPEN_MESSAGE_TYPE, agentId: "a" })
    h.post({ type: "aos:other", agentId: "a", sessionId: "t" })
    h.post("not-a-message")

    expect(onOpen.mock.calls).toEqual([
      [{ agentId: "a", sessionId: "t" }],
      [undefined],
      [undefined],
    ])
    stop()
    expect(h.listening()).toBe(false)
  })

  it("drops every observer on stop", () => {
    const h = setup()
    const onOpen = vi.fn()
    h.manager.listen({ onOpen })

    h.manager.stop()
    h.post({ type: OPEN_MESSAGE_TYPE, agentId: "a", sessionId: "t" })

    expect(onOpen).not.toHaveBeenCalled()
    expect(h.listening()).toBe(false)
  })
})

describe("the browser push platform", () => {
  it("decodes a base64url application server key into bytes", () => {
    expect([...decodeApplicationServerKey("BA-_")]).toEqual([4, 15, 191])
  })

  it("registers the worker, subscribes visibly, and bridges worker messages", async () => {
    const subscription = fakeSubscription("https://push.example/a")
    const subscribe = vi.fn(async () => subscription)
    const ready = {
      pushManager: { subscribe, getSubscription: async () => subscription },
    }
    const register = vi.fn(async () => ready)
    const listeners = new Set<(event: MessageEvent) => void>()
    const serviceWorker = {
      register,
      ready: Promise.resolve(ready),
      getRegistration: async () => ready,
      addEventListener: (
        _type: string,
        listener: (e: MessageEvent) => void
      ) => {
        listeners.add(listener)
      },
      removeEventListener: (
        _type: string,
        listener: (e: MessageEvent) => void
      ) => {
        listeners.delete(listener)
      },
    }
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    })
    vi.stubGlobal("PushManager", class {})
    try {
      const platform = createBrowserPushPlatform()
      expect(platform.supported).toBe(true)
      expect(platform.secureContext).toBe(window.isSecureContext)
      // Nothing to subscribe to before the worker is installed.
      expect(platform.subscribe(PUBLIC_KEY)).toBeNull()

      await platform.register()
      expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" })
      await expect(platform.subscribe(PUBLIC_KEY)).resolves.toBe(subscription)
      expect(subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(PUBLIC_KEY),
      })
      await expect(platform.getSubscription()).resolves.toBe(subscription)

      const received: unknown[] = []
      const stop = platform.onMessage((data) => received.push(data))
      for (const listener of listeners)
        listener({ data: { type: OPEN_MESSAGE_TYPE } } as MessageEvent)
      stop()
      expect(received).toEqual([{ type: OPEN_MESSAGE_TYPE }])
      expect(listeners.size).toBe(0)
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker")
    }
  })
})
