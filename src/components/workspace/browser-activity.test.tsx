import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useActivityCoordinator } from "./use-activity-coordinator"
import { ActivitySettings } from "./activity"
import { en } from "@/lib/i18n/dictionaries/en"
import type {
  WorkspaceActivityEvent,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import type { BrowserNotificationPort } from "@/lib/notifications/browser-port"
import {
  defaultBrowserPreferences,
  type BrowserPermission,
} from "@/lib/notifications/policy"
import { serializeActivity } from "@/lib/notifications/serialization"
import {
  createPushSubscriptionManager,
  type PushPlatform,
  type PushSubscriptionLike,
} from "@/lib/notifications/push-subscription"
import userEvent from "@testing-library/user-event"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it("enables from checkbox gesture, not mount/focus; a selected background completion opens its validated owner", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  let emit: (event: WorkspaceActivityEvent) => void = () => {}
  let click = () => {}
  const shown: unknown[] = []
  const close = vi.fn(),
    focus = vi.fn(),
    open = vi.fn(async () => {})
  let permission: NotificationPermission = "default"
  const request = vi.fn(() => {
    permission = "granted"
    return Promise.resolve(permission)
  })
  const port: BrowserNotificationPort = {
    getPermission: () => permission,
    requestPermission: request,
    show: (payload, onClick) => {
      shown.push(payload)
      click = onClick
      return { close }
    },
  }
  // The provider reports the Session unread, so a background alert is due.
  const session = {
    agentId: "a",
    threadId: "t",
    status: "idle" as const,
    updatedAt: "2026-09-05T12:00:00Z",
    unread: true,
  }
  const markSessionRead = vi.fn(async () => {})
  const workspace: WorkspaceAdapter = {
    listAgents: async () => [],
    refreshAgents: async () => [],
    createSession: async () => ({ threadId: "t" }),
    getSessionMetadata: async () => [session],
    subscribeActivity: (listener) => {
      emit = listener
      return () => {}
    },
    markSessionRead,
  }
  const props = {
    workspace,
    agents: [{ id: "a", name: "Secret agent" }],
    sessions: [session],
    titles: new Map([["t", "Secret session"]]),
    selection: { agentId: "a", threadId: "t" },
    locale: "en" as const,
    readNow: () => new Date(session.updatedAt),
    onOpenTarget: open,
    browser: {
      port,
      platform: {
        read: () => null,
        write() {},
        send() {},
        subscribe: () => () => {},
        startLeadership: () => () => {},
        isLeader: () => true,
        settleDelivery: (callback: () => void) => {
          callback()
          return () => {}
        },
        focus,
      },
      copy: {
        completion: en.activity.runFinished,
        failure: en.activity.runFailed,
        input: en.activity.inputRequested,
      },
    },
  }
  const { result } = renderHook(useActivityCoordinator, { initialProps: props })
  await act(async () => {})
  act(() => window.dispatchEvent(new Event("focus")))
  expect(request).not.toHaveBeenCalled()
  const view = render(
    <ActivitySettings
      dictionary={en}
      settings={{ ...result.current.browserSettings, coverage: "workspace" }}
    />
  )
  // Notifications ship on, so the checkbox starts checked and permission is
  // still the operator's to give.
  const checkbox = () =>
    screen.getByRole("checkbox", { name: en.activity.browserNotifications })
  expect(checkbox()).toBeChecked()
  await userEvent.click(checkbox())
  expect(request).not.toHaveBeenCalled()
  await act(async () => {})
  expect(result.current.browserSettings.preferences.enabled).toBe(false)
  view.rerender(
    <ActivitySettings
      dictionary={en}
      settings={{ ...result.current.browserSettings, coverage: "workspace" }}
    />
  )
  expect(checkbox()).not.toBeChecked()
  await userEvent.click(checkbox())
  expect(request).toHaveBeenCalledOnce()
  expect(result.current.browserSettings.preferences).toEqual({
    ...defaultBrowserPreferences,
    enabled: true,
  })
  await act(async () =>
    emit({
      id: "ready",
      ...session,
      type: "agent-ready",
      occurredAt: session.updatedAt,
    })
  )
  expect(shown).toHaveLength(1)
  expect(result.current.items[0]?.read).toBe(false)
  await act(async () => click())
  expect(close).toHaveBeenCalledOnce()
  expect(focus).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledWith("a", "t")
  expect(markSessionRead).toHaveBeenCalledWith("t")
  await act(async () =>
    emit({
      id: "stale",
      ...session,
      type: "agent-ready",
      occurredAt: session.updatedAt,
    })
  )
  workspace.getSessionMetadata = async () => []
  open.mockClear()
  await act(async () => click())
  expect(open).not.toHaveBeenCalled()
  expect(
    result.current.items.find((item) => item.id === "stale")
  ).toMatchObject({ available: false, resolved: true })
  view.unmount()
})

it("earns the ask from a watched run, chimes for input elsewhere, and asks from the gesture", async () => {
  // The operator is watching this tab, which is what the ask waits for.
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  let emit: (event: WorkspaceActivityEvent) => void = () => {}
  const request = vi.fn(async () => "granted" as NotificationPermission)
  const port: BrowserNotificationPort = {
    getPermission: () => "default",
    requestPermission: request,
    show: () => ({ close() {} }),
  }
  const sound = { play: vi.fn(), stop: vi.fn() }
  const watched = {
    agentId: "a",
    threadId: "t",
    status: "idle" as const,
    updatedAt: "2026-09-05T12:00:00Z",
    unread: true,
  }
  const elsewhere = { ...watched, agentId: "b", threadId: "other" }
  const sessions = [watched, elsewhere]
  const workspace: WorkspaceAdapter = {
    listAgents: async () => [],
    refreshAgents: async () => [],
    createSession: async () => ({ threadId: "t" }),
    getSessionMetadata: async (ids) =>
      sessions.filter((session) => ids.includes(session.threadId)),
    subscribeActivity: (listener) => {
      emit = listener
      return () => {}
    },
    markSessionRead: async () => {},
  }
  const { result } = renderHook(useActivityCoordinator, {
    initialProps: {
      workspace,
      agents: [
        { id: "a", name: "Aster" },
        { id: "b", name: "Mica" },
      ],
      sessions,
      titles: new Map<string, string>(),
      selection: { agentId: "a", threadId: "t" },
      locale: "en" as const,
      readNow: () => new Date(watched.updatedAt),
      onOpenTarget: async () => {},
      browser: {
        port,
        sound,
        platform: {
          read: () => null,
          write() {},
          send() {},
          subscribe: () => () => {},
          startLeadership: () => () => {},
          isLeader: () => true,
          settleDelivery: (callback: () => void) => {
            callback()
            return () => {}
          },
          focus() {},
        },
        copy: {
          completion: en.activity.runFinished,
          failure: en.activity.runFailed,
          input: en.activity.inputRequested,
        },
      },
    },
  })
  await act(async () => {})
  expect(result.current.browserSettings.ask).toBe(false)

  await act(async () =>
    emit({
      id: "start",
      agentId: "a",
      threadId: "t",
      type: "turn-started",
      turnId: "run-1",
      occurredAt: watched.updatedAt,
    })
  )
  expect(result.current.browserSettings.ask).toBe(true)
  expect(sound.play).not.toHaveBeenCalled()

  await act(async () =>
    emit({
      id: "input",
      agentId: "b",
      threadId: "other",
      type: "attention-requested",
      attentionKind: "question",
      requestId: "request-1",
      occurredAt: watched.updatedAt,
    })
  )
  expect(sound.play).toHaveBeenCalledOnce()

  // The ask answers from the click itself, so the request cannot wait.
  act(() => result.current.browserSettings.onAcceptAsk())
  expect(request).toHaveBeenCalledOnce()
  await act(async () => {})
  expect(result.current.browserSettings.ask).toBe(false)
  expect(result.current.browserSettings.preferences).toMatchObject({
    enabled: true,
    prompt: "accepted",
  })
})

it("hands this device's push subscription to the policy and the settings", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  let emit: (event: WorkspaceActivityEvent) => void = () => {}
  const shown: unknown[] = []
  const session = {
    agentId: "a",
    threadId: "t",
    status: "idle" as const,
    updatedAt: "2026-09-05T12:00:00Z",
    unread: true,
  }
  const workspace: WorkspaceAdapter = {
    listAgents: async () => [],
    refreshAgents: async () => [],
    createSession: async () => ({ threadId: "t" }),
    getSessionMetadata: async () => [session],
    subscribeActivity: (listener) => {
      emit = listener
      return () => {}
    },
    markSessionRead: async () => {},
  }
  let subscribed = true
  const sync = vi.fn(async () => {})
  const push = {
    status: () => "available" as const,
    active: () => subscribed,
    prepare: vi.fn(async () => {}),
    subscribeFromGesture: vi.fn(async () => "granted" as const),
    sync,
    listen: () => () => {},
    stop: vi.fn(),
  }
  const props = {
    workspace,
    agents: [{ id: "a", name: "Aster" }],
    sessions: [session],
    titles: new Map<string, string>(),
    selection: null,
    locale: "he" as const,
    readNow: () => new Date(session.updatedAt),
    onOpenTarget: async () => {},
    browser: {
      port: {
        getPermission: () => "granted" as const,
        requestPermission: async () => "granted" as const,
        show: (payload: unknown) => {
          shown.push(payload)
          return { close() {} }
        },
      },
      push,
      sound: { play() {}, stop() {} },
      platform: {
        read: () => null,
        write() {},
        send() {},
        subscribe: () => () => {},
        startLeadership: () => () => {},
        isLeader: () => true,
        settleDelivery: (callback: () => void) => {
          callback()
          return () => {}
        },
        focus() {},
      },
      copy: {
        completion: en.activity.runFinished,
        failure: en.activity.runFailed,
        input: en.activity.inputRequested,
      },
    },
  }
  const { result } = renderHook(useActivityCoordinator, { initialProps: props })
  await act(async () => {})

  expect(push.prepare).toHaveBeenCalledWith("granted")
  expect(result.current.browserSettings.push).toBe("available")
  expect(result.current.browserSettings.pushActive).toBe(true)
  expect(sync).toHaveBeenCalledWith(
    expect.objectContaining({ permission: "granted", locale: "he" })
  )

  // A subscribed device leaves the background alert to the push it will receive.
  await act(async () =>
    emit({
      id: "ready",
      ...session,
      type: "agent-ready",
      occurredAt: session.updatedAt,
    })
  )
  expect(shown).toEqual([])

  subscribed = false
  await act(async () =>
    emit({
      id: "next",
      ...session,
      type: "agent-ready",
      occurredAt: session.updatedAt,
    })
  )
  expect(shown).toHaveLength(1)
})

/**
 * A device that granted permission, subscribed, and stored the accepted ask —
 * which is exactly the state the browser can revoke behind the page's back.
 */
function subscribedDevice() {
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  let permission: BrowserPermission = "granted"
  let permissionChanged: (() => void) | undefined
  let emit: (event: WorkspaceActivityEvent) => void = () => {}
  const port: BrowserNotificationPort = {
    getPermission: () => permission,
    requestPermission: async () => permission,
    show: () => ({ close() {} }),
    onPermissionChange: (listener) => {
      permissionChanged = listener
      return () => {
        permissionChanged = undefined
      }
    },
  }
  const endpoint = "https://push.example/endpoint-1"
  const subscription: PushSubscriptionLike & {
    unsubscribe: ReturnType<typeof vi.fn>
  } = {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
    }),
    // The browser keeps the subscription when it revokes permission; dropping it
    // is this device's job.
    unsubscribe: vi.fn(async () => {
      subscribed = null
      return true
    }),
  }
  let subscribed: PushSubscriptionLike | null = subscription
  const client = {
    pushInfo: async () =>
      ({ status: "available", publicKey: "k".repeat(87) }) as const,
    putPushSubscription: vi.fn(async () => {}),
    deletePushSubscription: vi.fn(async () => {}),
  }
  const pushPlatform: PushPlatform = {
    supported: true,
    secureContext: true,
    register: async () => {},
    getSubscription: async () => subscribed,
    subscribe: () => null,
    onMessage: () => () => {},
  }
  const push = createPushSubscriptionManager({ client, platform: pushPlatform })
  const session = {
    agentId: "a",
    threadId: "t",
    status: "idle" as const,
    updatedAt: "2026-09-05T12:00:00Z",
    unread: true,
  }
  const workspace: WorkspaceAdapter = {
    listAgents: async () => [],
    refreshAgents: async () => [],
    createSession: async () => ({ threadId: "t" }),
    getSessionMetadata: async () => [session],
    subscribeActivity: (listener) => {
      emit = listener
      return () => {}
    },
    markSessionRead: async () => {},
  }
  const { result } = renderHook(useActivityCoordinator, {
    initialProps: {
      workspace,
      agents: [{ id: "a", name: "Aster" }],
      sessions: [session],
      titles: new Map<string, string>(),
      selection: { agentId: "a", threadId: "t" },
      locale: "en" as const,
      readNow: () => new Date(session.updatedAt),
      onOpenTarget: async () => {},
      browser: {
        port,
        push,
        sound: { play() {}, stop() {} },
        platform: {
          // The operator answered the ask on this device before.
          read: () =>
            serializeActivity({
              version: 3,
              preferences: { ...defaultBrowserPreferences, prompt: "accepted" },
            }),
          write() {},
          send() {},
          subscribe: () => () => {},
          startLeadership: () => () => {},
          isLeader: () => true,
          settleDelivery: (callback: () => void) => {
            callback()
            return () => {}
          },
          focus() {},
        },
        copy: {
          completion: en.activity.runFinished,
          failure: en.activity.runFailed,
          input: en.activity.inputRequested,
        },
      },
    },
  })
  return {
    result,
    client,
    subscription,
    endpoint,
    /** What the browser's own notification settings do behind the page's back. */
    revoke: (value: BrowserPermission, notice: "watcher" | "focus") => {
      permission = value
      if (notice === "watcher") permissionChanged?.()
      else window.dispatchEvent(new Event("focus"))
    },
    watchRun: () =>
      emit({
        id: "start",
        agentId: "a",
        threadId: "t",
        type: "turn-started",
        turnId: "run-1",
        occurredAt: session.updatedAt,
      }),
    closedAppLine: () => {
      const view = render(
        <ActivitySettings
          dictionary={en}
          settings={{
            ...result.current.browserSettings,
            coverage: "workspace",
          }}
        />
      )
      const line = screen.getByRole("status").textContent ?? ""
      view.unmount()
      return line
    },
  }
}

it("retires this device's subscription when the browser resets the permission", async () => {
  const device = subscribedDevice()
  await waitFor(() =>
    expect(device.client.putPushSubscription).toHaveBeenCalledOnce()
  )
  await act(async () => device.watchRun())

  expect(device.result.current.browserSettings.pushActive).toBe(true)
  expect(device.closedAppLine()).toContain(en.activity.pushOn)
  expect(device.result.current.browserSettings.ask).toBe(false)

  await act(async () => device.revoke("default", "watcher"))
  // Nothing can be displayed any more, so the proxy must stop pushing here.
  await waitFor(() =>
    expect(device.client.deletePushSubscription).toHaveBeenCalledWith(
      device.endpoint
    )
  )

  expect(device.subscription.unsubscribe).toHaveBeenCalledOnce()
  expect(device.result.current.browserSettings.status).toBe("default")
  expect(device.result.current.browserSettings.pushActive).toBe(false)
  // The stored accept is stale, so the operator is asked again.
  expect(device.result.current.browserSettings.ask).toBe(true)
  const line = device.closedAppLine()
  expect(line).toContain(en.activity.pushNotYet)
  expect(line).not.toContain(en.activity.pushOn)
})

it("retires it on the next focus when the browser blocks notifications", async () => {
  const device = subscribedDevice()
  await waitFor(() =>
    expect(device.client.putPushSubscription).toHaveBeenCalledOnce()
  )
  await act(async () => device.watchRun())
  expect(device.result.current.browserSettings.pushActive).toBe(true)

  await act(async () => device.revoke("denied", "focus"))
  await waitFor(() =>
    expect(device.client.deletePushSubscription).toHaveBeenCalledWith(
      device.endpoint
    )
  )

  expect(device.subscription.unsubscribe).toHaveBeenCalledOnce()
  expect(device.result.current.browserSettings.pushActive).toBe(false)
  // A blocked site is offered no ask; the master status line explains unblocking.
  expect(device.result.current.browserSettings.ask).toBe(false)
  const line = device.closedAppLine()
  expect(line).toContain(en.activity.pushBlocked)
  expect(line).not.toContain(en.activity.pushOn)
})
