import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMemo, useState } from "react"
import type {
  WorkspaceActivityEvent,
  WorkspaceAdapter,
  SessionMetadata,
} from "@/runtime-adapters/contracts"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { useActivityCoordinator } from "./use-activity-coordinator"
import {
  ActivityAsk,
  ActivityPanel,
  ActivityBell,
  ActivityNotice,
  ActivitySettings,
  type BrowserSettingsView,
} from "./activity"
import { defaultBrowserPreferences } from "@/lib/notifications/policy"

/** Everything the operator's notification surfaces read, with nothing on. */
function browserSettings(
  overrides: Partial<BrowserSettingsView> = {}
): BrowserSettingsView {
  return {
    status: "granted",
    coverage: "workspace",
    preferences: { ...defaultBrowserPreferences },
    ask: false,
    pushActive: false,
    push: "not-configured",
    installable: false,
    iosInstallHint: false,
    onEnabledChange: vi.fn(),
    onCategoryChange: vi.fn(),
    onSoundChange: vi.fn(),
    onAcceptAsk: vi.fn(),
    onDeclineAsk: vi.fn(),
    onInstall: vi.fn(),
    ...overrides,
  }
}

const now = new Date("2026-09-05T12:00:00Z")
// "one" is the exposed selection the provider already read; "two" is unread.
const sessions: SessionMetadata[] = [
  {
    threadId: "one",
    agentId: "a",
    status: "idle",
    updatedAt: now.toISOString(),
    unread: false,
  },
  {
    threadId: "two",
    agentId: "b",
    status: "idle",
    updatedAt: now.toISOString(),
    unread: true,
  },
]
const agents = [
  { id: "a", name: "Aster" },
  { id: "b", name: "Mica" },
]
function source() {
  let receive: (event: WorkspaceActivityEvent) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const unsubscribe = vi.fn()
  const markSessionRead = vi.fn(async () => {})
  const reportFocus = vi.fn()
  const workspace: WorkspaceAdapter = {
    listAgents: async () => [],
    refreshAgents: async () => [],
    createSession: async () => ({ threadId: "one" }),
    getSessionMetadata: async (ids) =>
      sessions.filter((session) => ids.includes(session.threadId)),
    subscribeActivity: vi.fn((listener, onError) => {
      receive = listener
      fail = onError!
      return unsubscribe
    }),
    markSessionRead,
    reportFocus,
  }
  const emit = (
    id: string,
    threadId = "two",
    type: "attention-requested" | "agent-ready" = "agent-ready"
  ) =>
    receive({
      id,
      threadId,
      agentId: threadId === "one" ? "a" : "b",
      occurredAt: now.toISOString(),
      ...(type === "attention-requested"
        ? { type, requestId: id, attentionKind: "question" }
        : { type }),
    })
  return {
    workspace,
    emit,
    fail: () => fail(new Error("private error text")),
    unsubscribe,
    markSessionRead,
    reportFocus,
  }
}
function options(
  workspace: WorkspaceAdapter
): Parameters<typeof useActivityCoordinator>[0] {
  return {
    workspace,
    agents,
    sessions,
    titles: new Map([
      ["one", "First"],
      ["two", "Second"],
    ]),
    selection: { agentId: "a", threadId: "one" },
    locale: "en",
    readNow: () => now,
    onOpenTarget: vi.fn(async () => {}),
  }
}
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("Activity coordinator", () => {
  it("revalidates cached ownership and rejects delayed arrivals after provider deletion", async () => {
    const provider = source()
    const props = { ...options(provider.workspace), sessions: [sessions[0]!] }
    const { result, rerender } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    await act(async () => provider.emit("before-deletion"))
    expect(result.current.items).toHaveLength(1)
    rerender({ ...props, sessions })
    provider.workspace.getSessionMetadata = async () => []
    rerender(props)
    await act(async () => provider.emit("after-deletion"))
    expect(result.current.items.map((item) => item.id)).toEqual([
      "before-deletion",
    ])
    expect(result.current.items.every((item) => item.read)).toBe(true)
    expect(result.current.items[0]).toMatchObject({
      available: false,
      resolved: true,
    })
    expect(result.current.notice).toBeNull()
  })

  it("opens a provider-validated target while local Session metadata is temporarily absent", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { result, rerender } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    await act(async () => provider.emit("event"))
    rerender({ ...props, sessions: [sessions[0]!] })
    expect(result.current.items[0]).toMatchObject({
      available: true,
      resolved: false,
    })
    await act(async () => {
      expect(await result.current.openActivity("event")).toBe(true)
    })
    expect(props.onOpenTarget).toHaveBeenCalledWith("b", "two")
    expect(provider.markSessionRead).toHaveBeenCalledWith("two")
    expect(result.current.items[0]).toMatchObject({
      resolved: false,
      available: true,
    })
  })

  it("shows a content-free interrupted state when subscription fails immediately", async () => {
    const provider = source()
    provider.workspace.subscribeActivity = (_listener, onError) => {
      onError?.(new Error("private error"))
      return () => {}
    }
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: options(provider.workspace),
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.error).toBe(true)
  })

  it("rejects delayed events after authoritative ownership changes", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { result, rerender } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    rerender({
      ...props,
      sessions: [sessions[0]!, { ...sessions[1]!, agentId: "a" }],
    })
    await act(async () => provider.emit("wrong-owner"))
    expect(result.current.items).toHaveLength(0)
    expect(result.current.notice).toBeNull()
  })

  it("keeps a target unavailable after authoritative validation rejects stale local metadata", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    act(() => provider.emit("event"))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    provider.workspace.getSessionMetadata = async () => []
    await act(async () => {
      await result.current.openActivity("event")
    })
    expect(result.current.items[0]).toMatchObject({
      available: false,
      resolved: true,
    })
    expect(props.onOpenTarget).not.toHaveBeenCalled()
  })

  it("subscribes once across selection changes and cleans up", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { result, rerender, unmount } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    act(() => provider.emit("visible", "one"))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.items[0]!.read).toBe(true)
    expect(result.current.notice).toBeNull()
    rerender({ ...props, selection: { agentId: "b", threadId: "two" } })
    expect(provider.workspace.subscribeActivity).toHaveBeenCalledTimes(1)
    unmount()
    expect(provider.unsubscribe).toHaveBeenCalledTimes(1)
  })
  it("coalesces unread foreground arrivals without moving focus or exposing content", async () => {
    const provider = source()
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: options(provider.workspace),
    })
    const focused = document.activeElement
    act(() => {
      provider.emit("first")
      provider.emit("second", "two", "attention-requested")
      provider.emit("second", "two", "attention-requested")
    })
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(result.current.items.every((item) => !item.read)).toBe(true)
    expect(result.current.notice).toEqual({ count: 1, urgent: true })
    expect(document.activeElement).toBe(focused)
    render(
      <ActivityNotice
        notice={result.current.notice}
        dictionary={en}
        onDismiss={() => {}}
      />
    )
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(screen.getByRole("alert")).not.toHaveTextContent("Second")
  })
  it.each(["hidden", "blurred"])(
    "raises no notice while %s and reports the exposed Session once focus returns",
    async (state) => {
      const provider = source()
      const focus = vi.mocked(document.hasFocus)
      if (state === "hidden")
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
      else focus.mockReturnValue(false)
      const { result } = renderHook(useActivityCoordinator, {
        initialProps: options(provider.workspace),
      })
      act(() => provider.emit("event", "two"))
      await waitFor(() => expect(result.current.items).toHaveLength(1))
      expect(result.current.items[0]!.read).toBe(false)
      expect(result.current.notice).toBeNull()
      expect(provider.reportFocus.mock.calls).toEqual([[null]])
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
      focus.mockReturnValue(true)
      act(() => window.dispatchEvent(new Event("focus")))
      expect(provider.reportFocus.mock.calls).toEqual([[null], ["one"]])
    }
  )

  it("reports no exposure while a drawer covers the selected Session", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { rerender } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    await waitFor(() =>
      expect(provider.reportFocus.mock.calls).toEqual([["one"]])
    )
    rerender({ ...props, conversationExposed: false })
    expect(provider.reportFocus.mock.calls).toEqual([["one"], [null]])
  })
  it("isolates subscription errors and accepts later valid events", async () => {
    const provider = source()
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: options(provider.workspace),
    })
    act(() => {
      provider.fail()
      provider.emit("event")
    })
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.error).toBe(false)
  })
  it("resolves labels from current data and never navigates to deleted targets", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { result, rerender } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    act(() => provider.emit("event", "two", "attention-requested"))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    rerender({
      ...props,
      agents: [{ id: "b", name: "Renamed" }],
      titles: new Map([["two", "Renamed Session"]]),
    })
    expect(result.current.items[0]).toMatchObject({
      agentName: "Renamed",
      sessionTitle: "Renamed Session",
    })
    rerender({ ...props, sessions: [sessions[0]!] })
    provider.workspace.getSessionMetadata = async () => []
    expect(result.current.items[0]!.available).toBe(true)
    await act(async () => {
      expect(await result.current.openActivity("event")).toBe(false)
    })
    expect(props.onOpenTarget).not.toHaveBeenCalled()
    expect(result.current.items[0]).toMatchObject({
      read: true,
      resolved: true,
      available: false,
    })
  })
  it("validates and opens the owning Agent and Session then acknowledges it", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    act(() => provider.emit("event"))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.unreadCount).toBe(1)
    await act(async () => {
      expect(await result.current.openActivity("event")).toBe(true)
    })
    expect(props.onOpenTarget).toHaveBeenCalledWith("b", "two")
    expect(provider.markSessionRead).toHaveBeenCalledWith("two")
  })
})

describe("Activity presentation", () => {
  it.each([
    ["en", en],
    ["he", he],
  ] as const)(
    "caps visual counts but exposes the actual unread count in %s",
    (_locale, dictionary) => {
      render(
        <ActivityBell
          dictionary={dictionary}
          unread={12}
          open={false}
          onOpen={() => {}}
        />
      )
      expect(screen.getByRole("button")).toHaveAccessibleName(
        expect.stringContaining("12")
      )
      expect(screen.getByText("9+")).toHaveAttribute("aria-hidden", "true")
    }
  )
  it("uses a polite region for routine activity", () => {
    render(
      <ActivityNotice
        notice={{ count: 1, urgent: false }}
        dictionary={en}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByRole("status")).toBeVisible()
    expect(screen.queryByRole("alert")).toBeNull()
  })
  it("offers attention/history and marks every unread Session read", async () => {
    const user = userEvent.setup()
    const provider = source()
    const props = options(provider.workspace)
    function Harness() {
      const [sessionState, setSessionState] = useState(sessions)
      const workspace = useMemo<WorkspaceAdapter>(
        () => ({
          ...provider.workspace,
          markSessionRead: async (threadId) =>
            setSessionState((current) =>
              current.map((session) =>
                session.threadId === threadId
                  ? { ...session, unread: false }
                  : session
              )
            ),
        }),
        []
      )
      const activity = useActivityCoordinator({
        ...props,
        workspace,
        sessions: sessionState,
      })
      return (
        <ActivityPanel
          activity={activity}
          locale="en"
          dictionary={en}
          onOpened={() => {}}
        />
      )
    }
    render(<Harness />)
    act(() => {
      provider.emit("attention", "two", "attention-requested")
      provider.emit("complete")
    })
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Open:/ })).toHaveLength(2)
    )
    expect(
      within(screen.getByRole("region", { name: "Needs attention" })).getByText(
        "Your Agent needs input"
      )
    ).toBeVisible()
    expect(
      within(screen.getByRole("region", { name: "Earlier" })).getByText(
        "An Agent is ready"
      )
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Mark all read" }))
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled()
  })
  it("presents browser settings without prompting and calls only explicit user callbacks", async () => {
    const user = userEvent.setup()
    const onEnabledChange = vi.fn()
    const onCategoryChange = vi.fn()
    const onSoundChange = vi.fn()
    render(
      <ActivitySettings
        dictionary={en}
        settings={browserSettings({
          status: "default",
          coverage: "active-session",
          preferences: { ...defaultBrowserPreferences, enabled: false },
          onEnabledChange,
          onCategoryChange,
          onSoundChange,
        })}
      />
    )
    expect(onEnabledChange).not.toHaveBeenCalled()
    expect(screen.getByText(/active Session only/)).toBeVisible()
    await user.click(
      screen.getByRole("checkbox", { name: en.activity.browserNotifications })
    )
    expect(onEnabledChange).toHaveBeenCalledWith(true)
    await user.click(screen.getByRole("checkbox", { name: "Turn completions" }))
    expect(onCategoryChange).toHaveBeenCalledWith("completion", false)
    await user.click(screen.getByRole("checkbox", { name: en.activity.sound }))
    expect(onSoundChange).toHaveBeenCalledWith(false)
  })

  it.each([
    ["available", en.activity.pushOn],
    ["insecure-context", en.activity.pushInsecure],
    ["not-configured", en.activity.pushNotConfigured],
    ["unsupported", en.activity.pushUnsupported],
  ] as const)("reports closed-tab delivery as %s", (push, explanation) => {
    render(
      <ActivitySettings dictionary={en} settings={browserSettings({ push })} />
    )
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent(en.activity.whenClosed)
    expect(status).toHaveTextContent(explanation)
  })

  it("points an uninstalled iPhone at the Home Screen instead", () => {
    render(
      <ActivitySettings
        dictionary={en}
        settings={browserSettings({ push: "available", iosInstallHint: true })}
      />
    )
    expect(screen.getByRole("status")).toHaveTextContent(
      en.activity.pushIosHint
    )
  })

  it("offers installation only where the browser volunteered a prompt", async () => {
    const onInstall = vi.fn()
    const installable = render(
      <ActivitySettings
        dictionary={en}
        settings={browserSettings({ installable: true, onInstall })}
      />
    )
    await userEvent.click(
      screen.getByRole("button", { name: en.activity.install })
    )
    expect(onInstall).toHaveBeenCalledOnce()
    installable.unmount()
    render(<ActivitySettings dictionary={en} settings={browserSettings()} />)
    expect(
      screen.queryByRole("button", { name: en.activity.install })
    ).toBeNull()
  })
})

describe("the one-time ask", () => {
  it("stays hidden until the ask is due", () => {
    render(<ActivityAsk dictionary={en} settings={browserSettings()} />)
    expect(
      screen.queryByRole("region", { name: en.activity.askTitle })
    ).toBeNull()
  })

  it("keeps both answers in Tab order and reports the operator's choice", async () => {
    const user = userEvent.setup()
    const onAcceptAsk = vi.fn()
    const onDeclineAsk = vi.fn()
    render(
      <ActivityAsk
        dictionary={en}
        settings={browserSettings({ ask: true, onAcceptAsk, onDeclineAsk })}
      />
    )
    expect(
      screen.getByRole("region", { name: en.activity.askTitle })
    ).toBeVisible()
    // Closed-tab delivery is only promised where push can actually deliver.
    expect(screen.queryByText(en.activity.askClosed)).toBeNull()
    await user.tab()
    expect(
      screen.getByRole("button", { name: en.activity.askAccept })
    ).toHaveFocus()
    await user.tab()
    expect(
      screen.getByRole("button", { name: en.activity.askDecline })
    ).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onDeclineAsk).toHaveBeenCalledOnce()
    await user.click(
      screen.getByRole("button", { name: en.activity.askAccept })
    )
    expect(onAcceptAsk).toHaveBeenCalledOnce()
  })

  it("promises closed-tab delivery where push is available", () => {
    render(
      <ActivityAsk
        dictionary={en}
        settings={browserSettings({ ask: true, push: "available" })}
      />
    )
    expect(screen.getByText(en.activity.askClosed)).toBeVisible()
  })

  it("asks an uninstalled iPhone to install AOS instead of answering", () => {
    render(
      <ActivityAsk
        dictionary={en}
        settings={browserSettings({ ask: true, iosInstallHint: true })}
      />
    )
    expect(screen.getByText(en.activity.pushIosHint)).toBeVisible()
    expect(
      screen.queryByRole("button", { name: en.activity.askAccept })
    ).toBeNull()
  })

  it("labels the ask in Hebrew as well", () => {
    render(
      <ActivityAsk dictionary={he} settings={browserSettings({ ask: true })} />
    )
    expect(
      screen.getByRole("region", { name: he.activity.askTitle })
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: he.activity.askAccept })
    ).toBeVisible()
  })
})
