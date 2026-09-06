import { describe, expect, it, vi } from "vitest"
import { BrowserActivityCoordinator } from "./browser-coordinator"
import { ActivityStore } from "./store"
import { defaultBrowserPreferences, type BrowserPermission } from "./policy"
import type { BrowserNotificationPayload } from "./browser-port"
import { serializeActivity, deserializeActivity } from "./serialization"

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
  const store = new ActivityStore({ now: () => now, getThreadOwner: () => "a" })
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
  it("persists the merged state when a delayed peer snapshot arrives", () => {
    const h = setup()
    h.coordinator.start()
    h.coordinator.publish(h.store.ingest(event, context))
    h.receive({
      snapshot: serializeActivity({
        version: 1,
        records: [
          {
            ...event,
            id: "peer",
            read: true,
            resolved: true,
            browserDeliveredAt: null,
          },
        ],
        preferences: defaultBrowserPreferences,
      }),
      preferencesChanged: false,
    })
    expect(
      deserializeActivity(h.persisted()!)
        ?.records.map((record) => record.id)
        .sort()
    ).toEqual(["e", "peer"])
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
        version: 1,
        records: [],
        preferences: { ...defaultBrowserPreferences, enabled: false },
      })
    )
    h.coordinator.publish(h.store.ingest(event, context))
    expect(h.shown).toHaveLength(0)
  })
  it("does not defer foreground events into an alert when leadership changes in the background", async () => {
    const h = setup()
    h.localContext.pageVisible = true
    h.localContext.pageFocused = true
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.coordinator.publish(h.store.ingest(event, h.localContext))
    h.localContext.pageFocused = false
    h.elected()
    expect(h.shown).toHaveLength(0)
  })
  it("merges persisted peer records and preferences before writing a local read update", () => {
    const h = setup()
    h.coordinator.start()
    h.store.ingest(event, context)
    h.seed(
      serializeActivity({
        version: 1,
        records: [
          {
            ...event,
            id: "peer",
            read: false,
            resolved: false,
            browserDeliveredAt: null,
          },
        ],
        preferences: { ...defaultBrowserPreferences, enabled: true },
      })
    )
    h.store.markAllRead()
    h.coordinator.publish()
    const persisted = deserializeActivity(h.persisted()!)!
    expect(persisted.records.map((record) => record.id).sort()).toEqual([
      "e",
      "peer",
    ])
    expect(persisted.preferences.enabled).toBe(true)
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
      h.coordinator.publish(h.store.ingest(event, h.localContext))
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
      h.coordinator.publish(h.store.ingest(event, context))
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
    h.coordinator.publish(h.store.ingest(event, context))
    expect(h.store.records()[0]?.browserDeliveredAt).toBeNull()
    expect(h.store.records()).toHaveLength(1)
    h.coordinator.publish(h.store.ingest({ ...event, id: "next" }, context))
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
    h.coordinator.publish(h.store.ingest(event, context))
    h.coordinator.publish(
      h.store.ingest(
        { ...event, id: "failed", type: "agent-activation-failed" },
        context
      )
    )
    h.coordinator.publish(
      h.store.ingest(
        {
          ...event,
          id: "input",
          type: "attention-requested",
          attentionKind: "permission",
          requestId: "private-id",
        },
        context
      )
    )
    expect(h.shown.map((payload) => payload.body)).toEqual([
      "תור הסתיים",
      "תור נכשל",
      "הסוכן ממתין לתשובה שלכם",
    ])
    expect(JSON.stringify(h.shown)).not.toContain("private-id")
    h.coordinator.setCategory("completion", false)
    h.coordinator.publish(h.store.ingest({ ...event, id: "disabled" }, context))
    expect(h.shown).toHaveLength(3)
  })
  it("retains a live arrival during initial election and delivers once leadership settles", async () => {
    const h = setup()
    h.leader(false)
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.coordinator.publish(h.store.ingest(event, context)!)
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
  it("hydrates unread records and opt-in without retroactive delivery, even on repeated live provider IDs", () => {
    const h = setup()
    const record = {
      ...event,
      read: false,
      resolved: false,
      browserDeliveredAt: null,
    }
    h.seed(
      serializeActivity({
        version: 1,
        records: [record],
        preferences: { ...defaultBrowserPreferences, enabled: true },
      })
    )
    h.coordinator.start()
    expect(h.store.records()).toEqual([record])
    expect(h.store.ingest(event, context)).toBeNull()
    expect(h.shown).toEqual([])
  })
  it("delivers only new eligible leader arrivals and clicks focus then open the owning activity", async () => {
    const h = setup()
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    const arrival = h.store.ingest(
      { ...event, message: "private secret" },
      context
    )!
    h.coordinator.publish(arrival)
    expect(h.shown).toEqual([
      {
        title: "AOS",
        body: "A turn finished",
        icon: "/aos-ui-placeholder.svg",
        timestamp: now,
        tag: expect.stringMatching(/^aos-ui-/),
        renotify: false,
      },
    ])
    expect(JSON.stringify(h.shown)).not.toContain("private")
    expect(
      deserializeActivity(h.persisted()!)?.records[0]?.browserDeliveredAt
    ).toBe(event.occurredAt)
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
  it("never delivers from a follower or from ordinary synchronized hydration", async () => {
    const h = setup()
    h.coordinator.start()
    await h.coordinator.setEnabled(true)
    h.leader(false)
    h.coordinator.publish(h.store.ingest(event, context)!)
    expect(h.shown).toEqual([])
    h.leader(true)
    h.receive({ snapshot: h.persisted(), preferencesChanged: false })
    expect(h.shown).toEqual([])
  })
})
