import { describe, expect, it, vi } from "vitest"
import { BrowserActivityCoordinator } from "./browser-coordinator"
import { ActivityStore } from "./store"
import { defaultBrowserPreferences, type BrowserPermission } from "./policy"
import type { BrowserNotificationPayload } from "./browser-port"
import type { SessionMetadata } from "@/runtime-adapters/contracts"
import { serializeActivity } from "./serialization"

const now = Date.parse("2026-09-05T12:00:00Z")
const context = { selection: null, pageVisible: false, pageFocused: false }
const event = {
  id: "e",
  agentId: "a",
  threadId: "t",
  type: "agent-ready" as const,
  occurredAt: new Date(now).toISOString(),
}
function setup(permission: BrowserPermission = "granted") {
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
    port: {
      getPermission: () => permission,
      requestPermission: request,
      show,
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
        version: 2,
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
        version: 2,
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
    expect(h.coordinator.settings().preferences.enabled).toBe(false)
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
        version: 2,
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
