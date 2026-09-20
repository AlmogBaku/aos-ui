import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
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
import { defaultBrowserPreferences } from "@/lib/notifications/policy"
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
      type: "run-started",
      lifecycleId: "run-1",
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
