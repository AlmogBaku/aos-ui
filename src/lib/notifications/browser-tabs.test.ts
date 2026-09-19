import { expect, it } from "vitest"
import {
  BrowserActivityCoordinator,
  type ActivityBrowserPlatform,
} from "./browser-coordinator"
import { DeliveryLeader } from "./delivery-leader"
import { ActivityStore } from "./store"
import { deserializeActivity } from "./serialization"
import type { SessionMetadata } from "@/runtime-adapters/contracts"

/** The provider keeps this Session unread, so every alert below stays due. */
const unreadSessions: SessionMetadata[] = [
  {
    threadId: "t",
    agentId: "a",
    status: "idle",
    updatedAt: "2026-09-05T12:00:00.000Z",
    unread: true,
  },
]

it.each([
  [true, true, ["hidden"]],
  [true, false, []],
  [false, true, ["hidden"]],
  [false, false, []],
])(
  "delivers one OS alert only while the provider reports the Session unread (hidden leader first=%s, unread=%s)",
  async (leaderFirst, unread, expected) => {
    const now = Date.parse("2026-09-05T12:00:00Z")
    let saved: string | null = null
    const messages: (() => void)[] = [],
      settlements: (() => void)[] = []
    const listeners = new Map<string, (value: unknown) => void>()
    const shown: string[] = []
    const background = {
      selection: null,
      pageVisible: false,
      pageFocused: false,
    }
    const foreground = {
      selection: { agentId: "a", threadId: "t" },
      pageVisible: true,
      pageFocused: true,
    }
    // Every tab sees the same authoritative Session state.
    const sessions: SessionMetadata[] = [
      {
        threadId: "t",
        agentId: "a",
        status: "idle",
        updatedAt: new Date(now).toISOString(),
        unread,
      },
    ]
    const make = (
      id: string,
      context: typeof background | typeof foreground
    ) => {
      const store = new ActivityStore({
        now: () => now,
        getThreadOwner: () => "a",
        getSessions: () => sessions,
      })
      const platform = {
        read: () => saved,
        write: (value: string) => {
          saved = value
        },
        send: (value: unknown) => {
          for (const [peer, listener] of listeners)
            if (peer !== id) messages.push(() => listener(value))
        },
        subscribe: (listener: (value: unknown) => void) => {
          listeners.set(id, listener)
          return () => {
            listeners.delete(id)
          }
        },
        startLeadership: () => () => {},
        isLeader: () => id === "hidden",
        focus() {},
        settleDelivery: (callback: () => void) => {
          settlements.push(callback)
          return () => {}
        },
      }
      const coordinator = new BrowserActivityCoordinator({
        store,
        platform,
        context: () => context,
        now: () => now,
        copy: () => ({
          completion: "A turn finished",
          failure: "A turn failed",
          input: "Your Agent needs input",
        }),
        port: {
          getPermission: () => "granted",
          requestPermission: async () => "granted",
          show: () => {
            shown.push(id)
            return { close() {} }
          },
        },
        onChange() {},
        open: async () => true,
      })
      coordinator.start()
      return { store, coordinator, context }
    }
    const hidden = make("hidden", background),
      focused = make("focused", foreground)
    await hidden.coordinator.setEnabled(true)
    while (messages.length) messages.shift()!()
    const event = {
      id: "ready",
      agentId: "a",
      threadId: "t",
      type: "agent-ready" as const,
      occurredAt: new Date(now).toISOString(),
    }
    const first = leaderFirst ? hidden : focused,
      second = leaderFirst ? focused : hidden
    first.coordinator.publish(first.store.ingest(event))
    while (messages.length) messages.shift()!()
    second.coordinator.publish(second.store.ingest(event))
    while (messages.length) messages.shift()!()
    while (settlements.length) settlements.shift()!()
    expect(shown).toEqual(expected)
    expect(focused.store.records()[0]?.read).toBe(!unread)
    hidden.coordinator.stop()
    focused.coordinator.stop()
  }
)

it("recovers live delivery with heartbeats throttled beyond the lease duration", async () => {
  let now = Date.parse("2026-09-05T12:00:00Z")
  let saved: string | null = null
  const storage = new Map<string, string>()
  let tick = () => {}
  const election = new DeliveryLeader({
    id: "only",
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
      tick = callback
      return () => {}
    },
  })
  const context = { selection: null, pageVisible: false, pageFocused: false }
  const store = new ActivityStore({
    now: () => now,
    getThreadOwner: () => "a",
    getSessions: () => unreadSessions,
  })
  const shown: string[] = []
  const delayedDelivery: (() => void)[] = []
  const coordinator = new BrowserActivityCoordinator({
    store,
    now: () => now,
    context: () => context,
    copy: () => ({
      completion: "A turn finished",
      failure: "A turn failed",
      input: "Your Agent needs input",
    }),
    platform: {
      read: () => saved,
      write: (value) => {
        saved = value
      },
      send() {},
      subscribe: () => () => {},
      startLeadership: (callback) => election.start(callback),
      isLeader: () => election.isLeader(),
      settleDelivery: (callback) => {
        delayedDelivery.push(callback)
        return () => {}
      },
      focus() {},
    },
    port: {
      getPermission: () => "granted",
      requestPermission: async () => "granted",
      show: (payload) => {
        shown.push(payload.body)
        return { close() {} }
      },
    },
    open: async () => true,
    onChange() {},
  })
  coordinator.start()
  await coordinator.setEnabled(true)
  const event = {
    id: "ready",
    agentId: "a",
    threadId: "t",
    type: "agent-ready" as const,
    occurredAt: new Date(now).toISOString(),
  }
  coordinator.publish(store.ingest(event))
  now += 20000
  tick()
  expect(election.isLeader()).toBe(true)
  // The notification settlement timer is throttled too, and may wake before
  // the next heartbeat. It must revalidate/reacquire the unchanged self lease.
  now += 20000
  while (delayedDelivery.length) delayedDelivery.shift()!()
  expect(shown).toEqual(["A turn finished"])
  now += 20000
  coordinator.publish(
    store.ingest({
      ...event,
      id: "later",
      occurredAt: new Date(now).toISOString(),
    })
  )
  now += 20000
  tick()
  while (delayedDelivery.length) delayedDelivery.shift()!()
  expect(shown).toEqual(["A turn finished", "A turn finished"])
  tick()
  expect(shown).toHaveLength(2)
  coordinator.stop()
})

it("synchronizes live arrivals, delivery announcements, and preferences with one lease leader and failover", async () => {
  let now = Date.parse("2026-09-05T12:00:00Z")
  let saved: string | null = null
  const leases = new Map<string, string>()
  const listeners = new Map<string, (value: unknown) => void>()
  const ticks = new Map<string, () => void>()
  const queue: (() => void)[] = []
  const context = { selection: null, pageVisible: false, pageFocused: false }
  const notifications: string[] = []
  const flush = () => {
    let work = 0
    while (queue.length && work++ < 100) queue.shift()!()
    expect(queue).toHaveLength(0)
  }
  function tab(id: string) {
    const store = new ActivityStore({
      now: () => now,
      getThreadOwner: () => "a",
      getSessions: () => unreadSessions,
    })
    const election = new DeliveryLeader({
      id,
      now: () => now,
      storage: {
        getItem: (key) => leases.get(key) ?? null,
        setItem: (key, value) => {
          leases.set(key, value)
        },
        removeItem: (key) => {
          leases.delete(key)
        },
      },
      repeat: (callback) => {
        ticks.set(id, callback)
        return () => {
          ticks.delete(id)
        }
      },
    })
    const platform: ActivityBrowserPlatform = {
      read: () => saved,
      write: (value) => {
        saved = value
      },
      send: (value) => {
        for (const [peer, listener] of listeners)
          if (peer !== id) queue.push(() => listener(value))
      },
      subscribe: (listener) => {
        listeners.set(id, listener)
        return () => {
          listeners.delete(id)
        }
      },
      startLeadership: (callback) => election.start(callback),
      isLeader: () => election.isLeader(),
      settleDelivery: (callback) => {
        callback()
        return () => {}
      },
      focus() {},
    }
    const coordinator = new BrowserActivityCoordinator({
      store,
      platform,
      port: {
        getPermission: () => "granted",
        requestPermission: async () => "granted",
        show: () => {
          notifications.push(id)
          return { close() {} }
        },
      },
      now: () => now,
      context: () => context,
      copy: () => ({
        completion: "A turn finished",
        failure: "A turn failed",
        input: "Your Agent needs input",
      }),
      onChange() {},
      open: async () => true,
    })
    coordinator.start()
    return { store, coordinator }
  }
  const a = tab("one"),
    b = tab("two")
  ticks.get("one")!()
  ticks.get("two")!()
  flush()
  await b.coordinator.setEnabled(true)
  flush()
  expect(a.coordinator.settings().preferences.enabled).toBe(true)
  const event = {
    id: "ready",
    type: "agent-ready" as const,
    agentId: "a",
    threadId: "t",
    occurredAt: new Date(now).toISOString(),
  }
  b.coordinator.publish(b.store.ingest(event))
  a.coordinator.publish(a.store.ingest(event))
  flush()
  expect(notifications).toEqual(["one"])
  expect(a.store.records()[0]?.browserDeliveredAt).toBe(event.occurredAt)
  expect(b.store.records()[0]?.browserDeliveredAt).toBe(event.occurredAt)
  b.coordinator.setCategory("input", false)
  flush()
  expect(a.coordinator.settings().preferences.input).toBe(false)
  a.coordinator.stop()
  now += 15000
  ticks.get("two")!()
  ticks.get("two")!()
  flush()
  expect(notifications).toEqual(["one"])
  b.coordinator.publish(
    b.store.ingest({
      ...event,
      id: "next",
      occurredAt: new Date(now).toISOString(),
    })
  )
  flush()
  expect(notifications).toEqual(["one", "two"])
  expect(deserializeActivity(saved!)?.preferences.input).toBe(false)
  b.coordinator.stop()
  expect(listeners.size).toBe(0)
  expect(ticks.size).toBe(0)
})
