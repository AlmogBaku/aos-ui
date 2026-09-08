import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createBrowserNotificationPort,
  createActivityBrowserPlatform,
} from "./browser-platform"
import { DeliveryLeader } from "./delivery-leader"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe("browser adapters", () => {
  it("settles delivery after peer messages and cancels pending settlement on cleanup", () => {
    vi.useFakeTimers()
    const platform = createActivityBrowserPlatform()
    const deliver = vi.fn()
    const cancel = platform.settleDelivery(deliver)
    expect(deliver).not.toHaveBeenCalled()
    vi.advanceTimersByTime(149)
    expect(deliver).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(deliver).toHaveBeenCalledOnce()
    cancel()
    const cancelPending = platform.settleDelivery(deliver)
    cancelPending()
    vi.runOnlyPendingTimers()
    expect(deliver).toHaveBeenCalledOnce()
  })
  it("releases on pagehide and resumes leadership after bfcache pageshow", () => {
    vi.useFakeTimers()
    localStorage.clear()
    const platform = createActivityBrowserPlatform()
    const stop = platform.startLeadership()
    vi.advanceTimersByTime(1000)
    expect(platform.isLeader()).toBe(true)
    window.dispatchEvent(new Event("pagehide"))
    expect(platform.isLeader()).toBe(false)
    window.dispatchEvent(new Event("pageshow"))
    vi.advanceTimersByTime(1000)
    expect(platform.isLeader()).toBe(true)
    stop()
    // jsdom schedules storage-event tasks for the lease writes/removal.
    vi.runOnlyPendingTimers()
    expect(vi.getTimerCount()).toBe(0)
    localStorage.clear()
  })
  it("defers Notification access until used and handles absent support", () => {
    vi.stubGlobal("Notification", undefined)
    const port = createBrowserNotificationPort()
    expect(port.getPermission()).toBe("unsupported")
  })
  it("forwards only allowed notification options and catches callback errors", () => {
    const instances: {
      title: string
      options: unknown
      onclick?: () => void
    }[] = []
    class NotificationDouble {
      static permission = "granted"
      onclick?: () => void
      constructor(
        public title: string,
        public options: unknown
      ) {
        instances.push(this)
      }
      close() {}
    }
    vi.stubGlobal("Notification", NotificationDouble)
    const port = createBrowserNotificationPort()
    port.show(
      {
        title: "AOS",
        body: "A turn finished",
        icon: "/logo-adaptive.svg",
        timestamp: 100,
        tag: "aos-ui-id",
        renotify: false,
      },
      () => {
        throw Error("failed click")
      }
    )
    expect(instances).toHaveLength(1)
    expect(instances[0]?.options).toEqual({
      body: "A turn finished",
      icon: "/logo-adaptive.svg",
      timestamp: 100,
      tag: "aos-ui-id",
      renotify: false,
    })
    expect(() => instances[0]?.onclick?.()).not.toThrow()
  })
  it("uses BroadcastChannel and closes it on cleanup", () => {
    const messages: unknown[] = []
    const close = vi.fn()
    let receive: (event: { data: unknown }) => void = () => {}
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        set onmessage(listener: (event: { data: unknown }) => void) {
          receive = listener
        }
        postMessage(value: unknown) {
          messages.push(value)
        }
        close = close
      }
    )
    const platform = createActivityBrowserPlatform()
    const listener = vi.fn()
    const cleanup = platform.subscribe(listener)
    platform.send({ snapshot: "test" })
    expect(messages).toEqual([{ snapshot: "test" }])
    expect(localStorage.getItem("aos-ui.activity.message.v1")).toContain("test")
    receive({ data: { snapshot: "other" } })
    expect(listener).toHaveBeenCalledWith({ snapshot: "other" })
    listener.mockClear()
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "aos-ui.activity.message.v1",
        newValue: localStorage.getItem("aos-ui.activity.message.v1"),
      })
    )
    expect(listener).not.toHaveBeenCalled()
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "aos-ui.activity.message.v1",
        newValue: JSON.stringify({
          channelSent: false,
          value: { snapshot: "fallback-peer" },
        }),
      })
    )
    expect(listener).toHaveBeenCalledWith({ snapshot: "fallback-peer" })
    cleanup()
    expect(close).toHaveBeenCalledOnce()
  })
  it("falls back to storage messages and removes listeners", () => {
    vi.stubGlobal("BroadcastChannel", undefined)
    const platform = createActivityBrowserPlatform()
    const receive = vi.fn()
    const cleanup = platform.subscribe(receive)
    platform.send({ snapshot: "test", preferencesChanged: false })
    const value = localStorage.getItem("aos-ui.activity.message.v1")
    expect(value).toContain("test")
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "aos-ui.activity.message.v1",
        newValue: value,
      })
    )
    expect(receive).toHaveBeenCalledWith({
      snapshot: "test",
      preferencesChanged: false,
    })
    cleanup()
    receive.mockClear()
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "aos-ui.activity.message.v1",
        newValue: value,
      })
    )
    expect(receive).not.toHaveBeenCalled()
    localStorage.clear()
  })
})
describe("OS delivery election", () => {
  it("hands an exclusive Web Lock to a waiting tab after leader cleanup", async () => {
    let held = false
    const waiting: (() => void)[] = []
    const locks = {
      request: (
        _name: string,
        options: { signal: AbortSignal },
        callback: () => Promise<void>
      ) =>
        new Promise<void>((resolve, reject) => {
          const run = () => {
            if (options.signal.aborted) {
              reject(new Error("aborted"))
              return
            }
            held = true
            void callback().finally(() => {
              held = false
              resolve()
              waiting.shift()?.()
            })
          }
          if (held) waiting.push(run)
          else run()
        }),
    }
    const options = {
      now: () => 0,
      locks,
      storage: { getItem: () => null, setItem() {}, removeItem() {} },
      repeat: () => () => {},
    }
    const a = new DeliveryLeader({ ...options, id: "a" })
    const b = new DeliveryLeader({ ...options, id: "b" })
    const stopA = a.start(),
      stopB = b.start()
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false])
    stopA()
    await Promise.resolve()
    await Promise.resolve()
    expect([a.isLeader(), b.isLeader()]).toEqual([false, true])
    stopB()
    await Promise.resolve()
    await Promise.resolve()
    expect([a.isLeader(), b.isLeader()]).toEqual([false, false])
  })
  function leaseHarness() {
    const storage = new Map<string, string>()
    let now = 1000
    const callbacks = new Map<string, () => void>()
    const make = (id: string) =>
      new DeliveryLeader({
        id,
        now: () => now,
        storage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => {
            storage.set(key, value)
          },
          removeItem: (key) => {
            storage.delete(key)
          },
        },
        repeat: (callback) => {
          callbacks.set(id, callback)
          return () => {
            callbacks.delete(id)
          }
        },
      })
    return {
      make,
      callbacks,
      advance: (ms: number) => {
        now += ms
      },
    }
  }
  it("settles one lease owner, renews and fails over after cleanup or expiry", () => {
    const h = leaseHarness()
    const a = h.make("a"),
      b = h.make("b")
    const stopA = a.start(),
      stopB = b.start()
    h.callbacks.get("a")!()
    h.callbacks.get("b")!()
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false])
    h.advance(4000)
    h.callbacks.get("a")!()
    h.callbacks.get("b")!()
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false])
    stopA()
    h.callbacks.get("b")!()
    h.callbacks.get("b")!()
    expect(b.isLeader()).toBe(true)
    h.advance(15000)
    const c = h.make("c"),
      stopC = c.start()
    h.callbacks.get("c")!()
    expect([b.isLeader(), c.isLeader()]).toEqual([false, true])
    stopB()
    stopC()
    expect(h.callbacks.size).toBe(0)
  })
  it("uses an exclusive held Web Lock and releases/aborts on cleanup", async () => {
    let releaseCallback: (() => void) | undefined
    let signal: AbortSignal | undefined
    const requests: string[] = []
    const locks = {
      request: async (
        name: string,
        options: { signal: AbortSignal },
        callback: () => Promise<void>
      ) => {
        requests.push(name)
        signal = options.signal
        await callback()
        releaseCallback?.()
      },
    }
    const released = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    const leader = new DeliveryLeader({
      id: "a",
      now: () => 0,
      locks,
      storage: {
        getItem: () => {
          throw Error("must not use lease")
        },
        setItem: () => {},
        removeItem: () => {},
      },
      repeat: () => () => {},
    })
    const stop = leader.start()
    expect(requests).toEqual(["aos-ui.activity.delivery.v1"])
    expect(leader.isLeader()).toBe(true)
    stop()
    await released
    expect(signal?.aborted).toBe(true)
    expect(leader.isLeader()).toBe(false)
  })
})
