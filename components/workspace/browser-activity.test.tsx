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
} from "@/lib/runtime-adapters/contracts"
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
  const session = {
    agentId: "a",
    threadId: "t",
    status: "idle" as const,
    updatedAt: "2026-09-05T12:00:00Z",
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
  }
  const props = {
    workspace,
    agents: [{ id: "a", name: "Secret agent" }],
    sessions: [session],
    titles: new Map([["t", "Secret session"]]),
    selection: { agentId: "a", threadId: "t" },
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
  await userEvent.click(
    screen.getByRole("checkbox", { name: en.activity.browserNotifications })
  )
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
  expect(result.current.items[0]?.read).toBe(true)
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
