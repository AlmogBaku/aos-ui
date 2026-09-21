import { describe, expect, it, vi } from "vitest"
import {
  BrowserActivityCoordinator,
  type BrowserActivityOptions,
} from "./browser-coordinator"
import { ActivityStore } from "./store"
import { defaultBrowserPreferences, type BrowserPermission } from "./policy"
import type { BrowserNotificationPayload } from "./browser-port"
import type { SessionMetadata } from "@/runtime-adapters/contracts"
import { deserializeActivity, serializeActivity } from "./serialization"

const now = Date.parse("2026-09-05T12:00:00Z")
const context = { selection: null, pageVisible: false, pageFocused: false }
const event = {
  id: "e",
  agentId: "a",
  threadId: "t",
  type: "agent-ready" as const,
  occurredAt: new Date(now).toISOString(),
}
function setup(
  permission: BrowserPermission = "granted",
  push?: BrowserActivityOptions["push"],
  installFirst?: BrowserActivityOptions["installFirst"]
) {
  // The provider reports the Session unread, which is what makes an alert due.
  const sessions: SessionMetadata[] = [
    {
      threadId: "t",
      agentId: "a",
      status: "idle",
      updatedAt: new Date(now).toISOString(),
      unread: true,
    },
  ]
  const store = new ActivityStore({
    now: () => now,
    getThreadOwner: () => "a",
    getSessions: () => sessions,
  })
  const shown: BrowserNotificationPayload[] = []
  let click = () => {}
  let receive: (value: unknown) => void = () => {}
  let persisted: string | null = null
  let leader = true
  let elected = () => {}
  const close = vi.fn()
  const focus = vi.fn()
  const open = vi.fn(async () => true)
  const request = vi.fn(async () => permission)
  const show = vi.fn(
    (payload: BrowserNotificationPayload, onClick: () => void) => {
      shown.push(payload)
      click = onClick
      return { close }
    }
  )
  const localContext = {
    ...context,
    selection: null as null | { agentId: string; threadId: string },
  }
  let permissionChanged: (() => void) | undefined
  const copy = {
    completion: "A turn finished",
    failure: "A turn failed",
    input: "Your Agent needs input",
  }
  const coordinator = new BrowserActivityCoordinator({
    store,
    now: () => now,
    context: () => localContext,
    copy: () => copy,
    push,
    installFirst,
    port: {
      getPermission: () => permission,
      requestPermission: request,
      show,
      onPermissionChange: (listener) => {
        permissionChanged = listener
        return () => {
          permissionChanged = undefined
        }
      },
    },
    platform: {
      read: () => persisted,
      write: (value) => {
        persisted = value
      },
      send: vi.fn(),
      subscribe: (listener) => {
        receive = listener
        return vi.fn()
      },
      startLeadership: (callback) => {
        elected = callback ?? (() => {})
        return vi.fn()
      },
      isLeader: () => leader,
      settleDelivery: (callback) => {
        callback()
        return () => {}
      },
      focus,
    },
    onChange: vi.fn(),
    open,
  })
  return {
    coordinator,
    sessions,
    localContext,
    copy,
    show,
    store,
    shown,
    request,
    close,
    focus,
    open,
    click: () => click(),
    receive: (value: unknown) => receive(value),
    persisted: () => persisted,
    seed: (value: string) => {
      persisted = value
    },
    leader: (value: boolean) => {
      leader = value
    },
    elected: () => elected(),
    permission: (value: BrowserPermission) => {
      permission = value
    },
    /** What the browser's own notification settings do behind the page's back. */
    changePermission: (value: BrowserPermission) => {
      permission = value
      permissionChanged?.()
    },
    watchingPermission: () => permissionChanged !== undefined,
  }
}
describe("live browser Activity", () => {
  it("never repeats an alert a peer announced, even after failover", async () => {
    const h = setup()
    h.leader(false)
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.coordinator.publish(h.store.ingest(event))
    h.receive({
      snapshot: serializeActivity({
        version: 3,
        preferences: { ...defaultBrowserPreferences, enabled: true },
      }),
      deliveredId: event.id,
      preferencesChanged: false,
    })
    expect(h.store.records()[0]?.browserDeliveredAt).toBe(event.occurredAt)
    h.leader(true)
    h.elected()
    expect(h.shown).toEqual([])
  })
  it("does not restore an older preference message over the latest persisted choice", async () => {
    const h = setup()
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    const older = h.persisted()
    await h.coordinator.setEnabled(false)
    h.receive({ snapshot: older, preferencesChanged: true })
    expect(h.coordinator.settings().preferences.enabled).toBe(false)
  })
  it("honors a peer's persisted opt-out before its synchronization message arrives", async () => {
    const h = setup()
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.seed(
      serializeActivity({
        version: 3,
        preferences: { ...defaultBrowserPreferences, enabled: false },
      })
    )
    h.coordinator.publish(h.store.ingest(event))
    expect(h.shown).toHaveLength(0)
  })
  it("does not defer foreground events into an alert when leadership changes in the background", async () => {
    const h = setup()
    h.localContext.pageVisible = true
    h.localContext.pageFocused = true
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.coordinator.publish(h.store.ingest(event))
    h.localContext.pageFocused = false
    h.elected()
    expect(h.shown).toHaveLength(0)
  })
  it("keeps a Session the provider already read out of OS delivery", async () => {
    const h = setup()
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.sessions[0]!.unread = false
    h.coordinator.publish(h.store.ingest(event))
    expect(h.shown).toEqual([])
  })
  it.each([
    [true, true, 0],
    [true, false, 1],
    [false, true, 1],
    [false, false, 1],
  ])(
    "delivery follows visible=%s focused=%s, including exact selected Session",
    async (visible, focused, count) => {
      const h = setup()
      h.localContext.pageVisible = !!visible
      h.localContext.pageFocused = !!focused
      h.localContext.selection = { agentId: "a", threadId: "t" }
      h.coordinator.start()
      await h.coordinator.setEnabled(true)
      h.coordinator.publish(h.store.ingest(event))
      expect(h.shown).toHaveLength(Number(count))
    }
  )
  it.each(["denied", "unsupported"] as const)(
    "never re-prompts %s even on explicit enable",
    async (permission) => {
      const h = setup(permission)
      h.coordinator.start()
      await h.coordinator.setEnabled(true)
      expect(h.request).not.toHaveBeenCalled()
      expect(h.coordinator.settings().preferences.enabled).toBe(false)
      h.coordinator.publish(h.store.ingest(event))
      expect(h.store.records()).toHaveLength(1)
      expect(h.shown).toEqual([])
    }
  )
  it("isolates rejected permission requests, failed constructors and failed click routing", async () => {
    const h = setup("default")
    h.coordinator.start()
    h.request.mockRejectedValueOnce(Error("request failed"))
    await expect(h.coordinator.setEnabled(true)).resolves.toBeUndefined()
    expect(h.coordinator.settings().preferences.enabled).toBe(false)
    h.permission("granted")
    await h.coordinator.setEnabled(true)
    h.show.mockImplementationOnce(() => {
      throw Error("constructor failed")
    })
    h.coordinator.publish(h.store.ingest(event))
    expect(h.store.records()[0]?.browserDeliveredAt).toBeNull()
    expect(h.store.records()).toHaveLength(1)
    h.coordinator.publish(h.store.ingest({ ...event, id: "next" }))
    h.open.mockRejectedValueOnce(Error("routing failed"))
    expect(() => h.click()).not.toThrow()
    await Promise.resolve()
    h.coordinator.stop()
    expect(h.close).toHaveBeenCalled()
  })
  it("maps activation failure and input to localized generic bodies and honors category switches", async () => {
    const h = setup()
    h.copy.completion = "תור הסתיים"
    h.copy.failure = "תור נכשל"
    h.copy.input = "הסוכן ממתין לתשובה שלכם"
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.coordinator.publish(h.store.ingest(event))
    h.coordinator.publish(
      h.store.ingest({
        ...event,
        id: "failed",
        type: "agent-activation-failed",
      })
    )
    h.coordinator.publish(
      h.store.ingest({
        ...event,
        id: "input",
        type: "attention-requested",
        attentionKind: "permission",
        requestId: "private-id",
      })
    )
    expect(h.shown.map((payload) => payload.body)).toEqual([
      "תור הסתיים",
      "תור נכשל",
      "הסוכן ממתין לתשובה שלכם",
    ])
    expect(JSON.stringify(h.shown)).not.toContain("private-id")
    h.coordinator.setCategory("completion", false)
    h.coordinator.publish(h.store.ingest({ ...event, id: "disabled" }))
    expect(h.shown).toHaveLength(3)
  })
  it("retains a live arrival during initial election and delivers once leadership settles", async () => {
    const h = setup()
    h.leader(false)
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.coordinator.publish(h.store.ingest(event)!)
    h.leader(true)
    h.elected()
    expect(h.shown).toHaveLength(1)
    h.elected()
    expect(h.shown).toHaveLength(1)
  })
  it.each(["default", "granted", "denied", "unsupported"] as const)(
    "checks %s without prompting on start or focus recheck",
    (permission) => {
      const h = setup(permission)
      h.coordinator.start()
      h.coordinator.recheckPermission()
      expect(h.coordinator.settings().status).toBe(permission)
      expect(h.request).not.toHaveBeenCalled()
      h.coordinator.stop()
    }
  )
  it("requests synchronously in the explicit enable action and enables only after grant", async () => {
    const h = setup("default")
    h.coordinator.start()
    const result = h.coordinator.setEnabled(true)
    expect(h.request).toHaveBeenCalledTimes(1)
    await result
    expect(h.coordinator.settings().preferences.enabled).toBe(false)
    h.permission("granted")
    await h.coordinator.setEnabled(true)
    expect(h.coordinator.settings().preferences.enabled).toBe(true)
    h.permission("denied")
    h.coordinator.recheckPermission()
    expect(h.coordinator.settings().status).toBe("denied")
    expect(h.request).toHaveBeenCalledTimes(1)
  })
  it("restores the opt-in without restoring Activity history or retroactive delivery", () => {
    const h = setup()
    h.seed(
      serializeActivity({
        version: 3,
        preferences: { ...defaultBrowserPreferences, enabled: true },
      })
    )
    h.coordinator.start()
    expect(h.coordinator.settings().preferences.enabled).toBe(true)
    expect(h.store.records()).toEqual([])
    expect(h.store.ingest(event)?.id).toBe(event.id)
    expect(h.shown).toEqual([])
  })
  it("delivers only new eligible leader arrivals and clicks focus then open the owning activity", async () => {
    const h = setup()
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    const arrival = h.store.ingest({ ...event, message: "private secret" })!
    h.coordinator.publish(arrival)
    expect(h.shown).toEqual([
      {
        title: "AOS",
        body: "A turn finished",
        icon: "/logo-adaptive.svg",
        timestamp: now,
        tag: expect.stringMatching(/^aos-ui-/),
        renotify: false,
      },
    ])
    expect(JSON.stringify(h.shown)).not.toContain("private")
    expect(h.store.records()[0]?.browserDeliveredAt).toBe(event.occurredAt)
    h.coordinator.publish(arrival)
    expect(h.shown).toHaveLength(1)
    h.click()
    await Promise.resolve()
    expect(h.close).toHaveBeenCalledOnce()
    expect(h.focus).toHaveBeenCalledOnce()
    expect(h.open).toHaveBeenCalledWith("e")
    expect(h.focus.mock.invocationCallOrder[0]).toBeLessThan(
      h.open.mock.invocationCallOrder[0]!
    )
  })
  it("never delivers from a follower or from an ordinary peer message", async () => {
    const h = setup()
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.leader(false)
    h.coordinator.publish(h.store.ingest(event)!)
    expect(h.shown).toEqual([])
    h.leader(true)
    h.receive({ snapshot: h.persisted(), preferencesChanged: false })
    expect(h.shown).toEqual([])
  })
})

describe("the one-time ask", () => {
  /** A watched run in the exposed Session is what earns the ask. */
  const watchRun = (h: ReturnType<typeof setup>) => {
    h.localContext.pageVisible = true
    h.localContext.pageFocused = true
    h.localContext.selection = { agentId: "a", threadId: "t" }
    h.coordinator.start()
    h.coordinator.noteRunStarted({ agentId: "a", threadId: "t" })
  }

  it("waits for a run the operator watched in this tab", () => {
    const h = setup("default")
    h.localContext.pageVisible = true
    h.localContext.pageFocused = true
    h.coordinator.start()
    expect(h.coordinator.settings().ask).toBe(false)
    h.coordinator.noteRunStarted({ agentId: "a", threadId: "t" })
    expect(h.coordinator.settings().ask).toBe(false)
    h.localContext.selection = { agentId: "a", threadId: "t" }
    h.coordinator.noteRunStarted({ agentId: "a", threadId: "other" })
    expect(h.coordinator.settings().ask).toBe(false)
    h.coordinator.noteRunStarted({ agentId: "a", threadId: "t" })
    expect(h.coordinator.settings().ask).toBe(true)
  })

  it.each([
    ["granted", true, "accepted"],
    ["denied", false, "pending"],
  ] as const)(
    "records a %s permission answer",
    async (answer, enabled, prompt) => {
      const h = setup("default")
      watchRun(h)
      h.request.mockResolvedValueOnce(answer)
      await h.coordinator.acceptAsk()
      expect(h.coordinator.settings().status).toBe(answer)
      expect(h.coordinator.settings().preferences).toMatchObject({
        enabled,
        prompt,
      })
      expect(h.coordinator.settings().ask).toBe(false)
    }
  )

  it("subscribes to push from the gesture itself, without a second request", async () => {
    const subscribeFromGesture = vi.fn(
      async () => "granted" as BrowserPermission
    )
    const h = setup("default", { active: () => false, subscribeFromGesture })
    watchRun(h)
    const accepted = h.coordinator.acceptAsk()
    expect(subscribeFromGesture).toHaveBeenCalledTimes(1)
    expect(h.request).not.toHaveBeenCalled()
    await accepted
    expect(h.coordinator.settings().preferences).toMatchObject({
      enabled: true,
      prompt: "accepted",
    })
  })

  it("requests permission itself when subscribing found no registration", async () => {
    const h = setup("default", {
      active: () => false,
      subscribeFromGesture: async () => "default",
    })
    watchRun(h)
    h.request.mockResolvedValueOnce("granted")
    await h.coordinator.acceptAsk()
    expect(h.request).toHaveBeenCalledTimes(1)
    expect(h.coordinator.settings().preferences).toMatchObject({
      enabled: true,
      prompt: "accepted",
    })
  })

  it("declines for every tab, including the ones that already asked", () => {
    const first = setup("default")
    const second = setup("default")
    for (const h of [first, second]) {
      watchRun(h)
      expect(h.coordinator.settings().ask).toBe(true)
    }
    first.coordinator.declineAsk()
    const snapshot = first.persisted()!
    expect(deserializeActivity(snapshot)?.preferences).toMatchObject({
      prompt: "declined",
      enabled: false,
    })
    expect(first.coordinator.settings().ask).toBe(false)
    second.seed(snapshot)
    second.receive({ snapshot, preferencesChanged: true })
    expect(second.coordinator.settings().preferences.prompt).toBe("declined")
    expect(second.coordinator.settings().ask).toBe(false)
  })

  it("returns when the browser resets a permission this device had accepted", () => {
    const h = setup("granted")
    // The operator accepted once, which is all the stored state remembers.
    h.seed(
      serializeActivity({
        version: 3,
        preferences: { ...defaultBrowserPreferences, prompt: "accepted" },
      })
    )
    watchRun(h)
    expect(h.coordinator.settings().ask).toBe(false)

    h.changePermission("default")

    expect(h.coordinator.settings().status).toBe("default")
    expect(h.coordinator.settings().ask).toBe(true)
    h.coordinator.stop()
    expect(h.watchingPermission()).toBe(false)
  })

  it("stays declined when the browser resets the permission", () => {
    const h = setup("granted")
    // A decline is the operator's own answer, even with alerts switched on since.
    h.seed(
      serializeActivity({
        version: 3,
        preferences: { ...defaultBrowserPreferences, prompt: "declined" },
      })
    )
    watchRun(h)

    h.changePermission("default")

    expect(h.coordinator.settings().ask).toBe(false)
  })

  it("offers nothing once the browser blocks notifications outright", () => {
    const h = setup("granted")
    h.seed(
      serializeActivity({
        version: 3,
        preferences: { ...defaultBrowserPreferences, prompt: "accepted" },
      })
    )
    watchRun(h)

    h.changePermission("denied")

    expect(h.coordinator.settings().status).toBe("denied")
    expect(h.coordinator.settings().ask).toBe(false)
  })

  it("offers itself to a device whose notifications need an install first", () => {
    // An uninstalled iOS tab has no notification API, which the port reports as
    // unsupported; the ask is the only thing that can tell the operator why.
    const h = setup("unsupported", undefined, () => true)
    watchRun(h)

    expect(h.coordinator.settings().ask).toBe(true)

    h.coordinator.declineAsk()
    expect(h.coordinator.settings().ask).toBe(false)
    expect(h.coordinator.settings().preferences.prompt).toBe("declined")
    expect(h.request).not.toHaveBeenCalled()
  })

  it("stays hidden on an unsupported browser that could not install either", () => {
    const h = setup("unsupported")
    watchRun(h)
    expect(h.coordinator.settings().ask).toBe(false)
  })

  it("publishes a sound choice like any other preference", () => {
    const h = setup()
    h.coordinator.start()
    h.coordinator.setSound(false)
    expect(h.coordinator.settings().preferences.sound).toBe(false)
    expect(deserializeActivity(h.persisted()!)?.preferences.sound).toBe(false)
  })
})

describe("a push-subscribed device", () => {
  it("leaves its OS alerts to push", async () => {
    const h = setup("granted", { active: () => true })
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    expect(h.coordinator.settings().pushActive).toBe(true)
    h.coordinator.publish(h.store.ingest(event))
    expect(h.show).not.toHaveBeenCalled()
  })

  it("keeps raising them itself while no subscription exists", async () => {
    const h = setup("granted", { active: () => false })
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    expect(h.coordinator.settings().pushActive).toBe(false)
    h.coordinator.publish(h.store.ingest(event))
    expect(h.show).toHaveBeenCalledTimes(1)
  })
})
