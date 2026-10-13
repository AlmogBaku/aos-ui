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
import type {
  AgentSummary,
  WorkspaceActivityEvent,
  WorkspaceAdapter,
  SessionMetadata,
} from "@/runtime-adapters/contracts"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import {
  useActivityCoordinator,
  type ActivityAgent,
} from "./use-activity-coordinator"
import { createFixtureWorkspace } from "@/runtime-adapters/fixture/fixture-workspace"
import {
  ActivityAsk,
  ActivityPanel,
  ActivityBell,
  ActivityNotice,
  ActivitySettings,
  type BrowserSettingsView,
} from "./activity"
import { defaultBrowserPreferences } from "@/lib/notifications/policy"
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_IDLE_MS,
} from "@harness-gw/sdk/protocol"
import { useFakeClock } from "../../../test/support/fake-clock"

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
    sessionId: "one",
    agentId: "a",
    status: "idle",
    updatedAt: now.toISOString(),
    unread: false,
  },
  {
    sessionId: "two",
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
  const markSessionRead = vi.fn<(sessionId: string) => Promise<void>>(
    async () => {}
  )
  const reportFocus = vi.fn()
  const workspace: WorkspaceAdapter = {
    listAgents: async () => [],
    refreshAgents: async () => [],
    createSession: async () => ({ sessionId: "one" }),
    getSessionMetadata: async (ids) =>
      sessions.filter((session) => ids.includes(session.sessionId)),
    subscribeActivity: vi.fn((listener, onError) => {
      receive = listener
      fail = onError!
      return unsubscribe
    }),
    markSessionRead,
    reportFocus,
  }
  /** An attention request from the Agent that owns `sessionId`. */
  const emit = (
    id: string,
    sessionId = "two",
    extra: { requestText?: string; requestMore?: number } = {}
  ) =>
    receive({
      id,
      sessionId,
      agentId: sessionId === "one" ? "a" : "b",
      occurredAt: now.toISOString(),
      type: "attention-requested",
      requestId: id,
      attentionKind: "question",
      ...extra,
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
    selection: { agentId: "a", sessionId: "one" },
    locale: "en",
    readNow: () => now,
    onOpenTarget: vi.fn(async () => {}),
    onOpenAgent: vi.fn(async () => {}),
    onActionError: vi.fn(),
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
    rerender({ ...props, selection: { agentId: "b", sessionId: "two" } })
    expect(provider.workspace.subscribeActivity).toHaveBeenCalledTimes(1)
    unmount()
    expect(provider.unsubscribe).toHaveBeenCalledTimes(1)
  })
  it("re-renders nothing when the window's focus changes and its Activity does not", async () => {
    const provider = source()
    let renders = 0
    const { result } = renderHook(
      (props: Parameters<typeof useActivityCoordinator>[0]) => {
        renders += 1
        return useActivityCoordinator(props)
      },
      { initialProps: options(provider.workspace) }
    )
    act(() => provider.emit("visible", "one"))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    await act(async () => {})
    const settled = renders
    await act(async () => {
      window.dispatchEvent(new Event("blur"))
      window.dispatchEvent(new Event("focus"))
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(renders).toBe(settled)
    expect(result.current.items.map((item) => item.id)).toEqual(["visible"])
  })
  it("coalesces unread foreground arrivals without moving focus or exposing content", async () => {
    const provider = source()
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: options(provider.workspace),
    })
    const focused = document.activeElement
    act(() => {
      provider.emit("first")
      provider.emit("second", "two")
      provider.emit("second", "two")
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
      expect(provider.reportFocus.mock.calls).toEqual([
        [null, { foreground: false, idle: false }],
      ])
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
      focus.mockReturnValue(true)
      act(() => window.dispatchEvent(new Event("focus")))
      expect(provider.reportFocus.mock.calls).toEqual([
        [null, { foreground: false, idle: false }],
        ["one", { foreground: true, idle: false }],
      ])
    }
  )

  it("reports no exposure while a drawer covers the selected Session", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { rerender } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    await waitFor(() =>
      expect(provider.reportFocus.mock.calls).toEqual([
        ["one", { foreground: true, idle: false }],
      ])
    )
    rerender({ ...props, conversationExposed: false })
    expect(provider.reportFocus.mock.calls).toEqual([
      ["one", { foreground: true, idle: false }],
      [null, { foreground: true, idle: false }],
    ])
  })

  it("reports this tab idle after three unattended minutes, and present again on input", async () => {
    vi.useFakeTimers()
    try {
      const provider = source()
      renderHook(useActivityCoordinator, {
        initialProps: options(provider.workspace),
      })
      await vi.waitFor(() =>
        expect(provider.reportFocus).toHaveBeenCalledTimes(1)
      )

      await act(async () => vi.advanceTimersByTime(PRESENCE_IDLE_MS))
      expect(provider.reportFocus).toHaveBeenLastCalledWith("one", {
        foreground: true,
        idle: true,
      })

      await act(async () =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
      )
      expect(provider.reportFocus).toHaveBeenLastCalledWith("one", {
        foreground: true,
        idle: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("repeats an unchanged report on the presence heartbeat, and only while foreground", async () => {
    vi.useFakeTimers()
    try {
      const provider = source()
      renderHook(useActivityCoordinator, {
        initialProps: options(provider.workspace),
      })
      await vi.waitFor(() =>
        expect(provider.reportFocus).toHaveBeenCalledTimes(1)
      )

      await act(async () => vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS))
      expect(provider.reportFocus.mock.calls).toEqual([
        ["one", { foreground: true, idle: false }],
        ["one", { foreground: true, idle: false }],
      ])

      vi.mocked(document.hasFocus).mockReturnValue(false)
      await act(async () => window.dispatchEvent(new Event("blur")))
      provider.reportFocus.mockClear()
      // A background tab has nothing to keep fresh; the gateway expires it.
      await act(async () => vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3))
      expect(provider.reportFocus).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
  it("holds back only the Session whose owner lookup never settles", async () => {
    const provider = source()
    // "one" is unknown locally, so its owner is asked of a provider that
    // never answers; "two" is known.
    provider.workspace.getSessionMetadata = () => new Promise(() => {})
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: {
        ...options(provider.workspace),
        sessions: [sessions[1]!],
      },
    })
    act(() => {
      provider.emit("stuck", "one")
      provider.emit("lands", "two")
    })
    await waitFor(() =>
      expect(result.current.items.map(({ id }) => id)).toEqual(["lands"])
    )
  })
  it("resolves labels from current data and never navigates to deleted targets", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { result, rerender } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    act(() => provider.emit("event", "two"))
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
  it("rings once per burst of Sessions newly waiting elsewhere, never for the one on screen", async () => {
    const clock = useFakeClock()
    const provider = source()
    const waiting = sessions.map((session) => ({
      ...session,
      status: "waiting-for-input" as const,
    }))
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: { ...options(provider.workspace), sessions: waiting },
    })
    await act(async () => provider.emit("on-screen", "one"))
    expect(result.current.ring).toBe(0)
    await act(async () => provider.emit("first", "two"))
    expect(result.current.ring).toBe(1)
    await act(async () => provider.emit("burst", "two"))
    expect(result.current.ring).toBe(1)
    await clock.advance(3000)
    await act(async () => provider.emit("later", "two"))
    expect(result.current.ring).toBe(2)
  })
  it("validates and opens the owning Agent and Session then acknowledges it", async () => {
    const provider = source()
    // An acknowledgment the provider refuses leaves the Session unread, which
    // is no Activity failure.
    provider.markSessionRead.mockRejectedValueOnce(new Error("read failed"))
    const props = options(provider.workspace)
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    act(() => provider.emit("event"))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.attention.count).toBe(1)
    await act(async () => {
      expect(await result.current.openActivity("event")).toBe(true)
    })
    expect(props.onOpenTarget).toHaveBeenCalledWith("b", "two")
    expect(provider.markSessionRead).toHaveBeenCalledWith("two")
    expect(result.current.error).toBe(false)
  })
  it("reports an open that fails as that action's failure, never as interrupted Activity", async () => {
    const provider = source()
    const failure = new Error("Session switch failed")
    const props = {
      ...options(provider.workspace),
      onOpenTarget: vi.fn(async () => {
        throw failure
      }),
    }
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    act(() => provider.emit("event"))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    await act(async () => {
      expect(await result.current.openActivity("event")).toBe(false)
    })
    expect(props.onActionError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(provider.markSessionRead).not.toHaveBeenCalled()
    expect(result.current.error).toBe(false)
  })
})

describe("Activity presentation", () => {
  it.each([
    ["en", en, "Activity, 12 unread, 1 waiting for you, 2 failed"],
    ["he", he, "פעילות, 12 לא נקראו, 1 ממתינים לתשובה, 2 נכשלו"],
  ] as const)(
    "caps the visual count but names every state in full in %s",
    (_locale, dictionary, name) => {
      render(
        <ActivityBell
          dictionary={dictionary}
          attention={{ count: 12, waiting: 1, failed: 2, top: "waiting" }}
          ring={0}
          open={false}
          onOpen={() => {}}
        />
      )
      expect(screen.getByRole("button")).toHaveAccessibleName(name)
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

  it.each<[string, Partial<BrowserSettingsView>, string]>([
    ["subscribed", { push: "available", pushActive: true }, en.activity.pushOn],
    // A deployment that offers push is not the same as a device that has it.
    [
      "offered but not subscribed",
      { push: "available", pushActive: false },
      en.activity.pushNotYet,
    ],
    [
      "blocked by the browser",
      { push: "available", pushActive: true, status: "denied" },
      en.activity.pushBlocked,
    ],
    ["insecure", { push: "insecure-context" }, en.activity.pushInsecure],
    ["unconfigured", { push: "not-configured" }, en.activity.pushNotConfigured],
    ["unsupported", { push: "unsupported" }, en.activity.pushUnsupported],
    [
      "waiting for an install",
      { push: "available", pushActive: true, iosInstallHint: true },
      en.activity.pushIosHint,
    ],
  ])(
    "reports this device's closed-tab delivery as %s",
    (_label, overrides, explanation) => {
      render(
        <ActivitySettings
          dictionary={en}
          settings={browserSettings(overrides)}
        />
      )
      const status = screen.getByRole("status")
      expect(status).toHaveTextContent(en.activity.whenClosed)
      expect(status).toHaveTextContent(explanation)
    }
  )

  it("never promises closed-tab delivery a blocked browser cannot make", () => {
    render(
      <ActivitySettings
        dictionary={en}
        settings={browserSettings({
          push: "available",
          pushActive: true,
          status: "denied",
        })}
      />
    )
    expect(screen.getByRole("status")).not.toHaveTextContent(en.activity.pushOn)
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

describe("the Activity inbox", () => {
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString()
  const inboxSessions: SessionMetadata[] = [
    {
      sessionId: "one",
      agentId: "a",
      status: "idle",
      updatedAt: minutesAgo(30),
      unread: true,
    },
    {
      sessionId: "two",
      agentId: "b",
      status: "waiting-for-input",
      updatedAt: minutesAgo(2),
      unread: true,
    },
    {
      sessionId: "three",
      agentId: "a",
      status: "failed",
      updatedAt: minutesAgo(60),
      unread: true,
    },
    // A hidden Agent's Session counts nowhere, so no action reaches it.
    {
      sessionId: "hidden",
      agentId: "h",
      status: "idle",
      updatedAt: minutesAgo(5),
      unread: true,
    },
  ]
  /** The panel over a live coordinator; `update` is the provider's next read. */
  function renderInbox(
    initial = inboxSessions,
    extraAgents: ActivityAgent[] = []
  ) {
    const provider = source()
    const props = {
      ...options(provider.workspace),
      agents: [
        ...agents,
        { id: "h", name: "Hidden", visibility: "hidden" as const },
        ...extraAgents,
      ],
      titles: new Map([
        ["one", "First"],
        ["two", "Second"],
        ["three", "Third"],
        ["four", "Fourth"],
        ["five", "Fifth"],
      ]),
    }
    const onOpened = vi.fn()
    function Harness({ sessions }: { sessions: SessionMetadata[] }) {
      const activity = useActivityCoordinator({ ...props, sessions })
      return (
        <ActivityPanel
          activity={activity}
          locale="en"
          dictionary={en}
          onOpened={onOpened}
        />
      )
    }
    const view = render(<Harness sessions={initial} />)
    return {
      provider,
      props,
      onOpened,
      update: (next: SessionMetadata[]) =>
        view.rerender(<Harness sessions={next} />),
    }
  }

  it("names each row in full, and marks it with the navigation rows' one dot", () => {
    renderInbox()
    for (const [name, dot] of [
      [
        "Mica, Second, waiting for your input, 2 minutes ago",
        "waiting for your input",
      ],
      ["Aster, First, Unread, 30 minutes ago", "Unread"],
      ["Aster, Third, Turn failed, 1 hour ago", "Turn failed"],
    ]) {
      const row = screen.getByRole("button", { name })
      expect(within(row).getByTitle(dot!)).toHaveAttribute(
        "aria-hidden",
        "true"
      )
    }
  })

  it("shows what a waiting row is asked, in its own direction, with how many follow", async () => {
    const { provider } = renderInbox()
    await act(async () =>
      provider.emit("asked", "two", {
        requestText: "Which dates work for you?",
        requestMore: 2,
      })
    )
    const row = screen.getByRole("button", {
      name: "Mica, Second, waiting for your input: Which dates work for you? +2 more, now",
    })
    expect(within(row).getByText("Which dates work for you?").tagName).toBe(
      "BDI"
    )
    expect(row).toHaveTextContent("Which dates work for you? +2 more")
  })

  it("opens a row's Session from the whole row, once the provider confirms its owner", async () => {
    const user = userEvent.setup()
    const { provider, props, onOpened } = renderInbox()
    // The provider no longer lists Third, so its row opens nothing.
    await user.click(screen.getByRole("button", { name: /^Aster, Third,/ }))
    await user.click(screen.getByRole("button", { name: /^Aster, First,/ }))
    await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
    expect(props.onOpenTarget).toHaveBeenCalledExactlyOnceWith("a", "one")
    expect(provider.markSessionRead).toHaveBeenCalledExactlyOnceWith("one")
  })

  it("marks one row read without opening it, and moves focus to the next row, else the previous, else the heading", async () => {
    const user = userEvent.setup()
    const { provider, props, update } = renderInbox()
    // Only answering clears a waiting Session, so it offers no Mark read.
    expect(
      screen.queryByRole("button", { name: "Mark read: Mica, Second" })
    ).toBeNull()

    await user.click(
      screen.getByRole("button", { name: "Mark read: Aster, First" })
    )
    expect(provider.markSessionRead).toHaveBeenCalledExactlyOnceWith("one")
    expect(props.onOpenTarget).not.toHaveBeenCalled()
    const third = screen.getByRole("button", { name: /^Aster, Third,/ })
    expect(third).toHaveFocus()
    update(
      inboxSessions.map((session) =>
        session.sessionId === "one" ? { ...session, unread: false } : session
      )
    )
    expect(screen.queryByRole("button", { name: /^Aster, First,/ })).toBeNull()
    expect(third).toHaveFocus()

    await user.click(
      screen.getByRole("button", { name: "Mark read: Aster, Third" })
    )
    expect(screen.getByRole("button", { name: /^Mica, Second,/ })).toHaveFocus()

    // Second is answered and read; Third is the last row left.
    update([inboxSessions[2]!])
    await user.click(
      screen.getByRole("button", { name: "Mark read: Aster, Third" })
    )
    expect(screen.getByRole("heading", { name: "Activity" })).toHaveFocus()
  })

  it("enables Mark all read only while a Session is unread and not waiting", async () => {
    const user = userEvent.setup()
    const { provider, update } = renderInbox()
    const markAll = screen.getByRole("button", { name: "Mark all read" })
    await user.click(markAll)
    expect(
      provider.markSessionRead.mock.calls.map(([sessionId]) => sessionId)
    ).toEqual(["one", "three"])
    // Reading a waiting Session changes nothing, so it neither takes this nor
    // enables it.
    update([inboxSessions[1]!])
    expect(markAll).toBeDisabled()
  })

  it("announces each waiting row that arrives while the drawer is open, once", () => {
    const { update } = renderInbox()
    const live = screen.getByRole("status")
    expect(live).toBeEmptyDOMElement()
    const arrival: SessionMetadata = {
      sessionId: "four",
      agentId: "a",
      status: "waiting-for-input",
      updatedAt: now.toISOString(),
    }
    update([...inboxSessions, arrival])
    expect(live).toHaveTextContent(/^Aster, Fourth, waiting for your input$/)
    // A later arrival is announced even when it lists below the first.
    const older = {
      ...arrival,
      sessionId: "five",
      updatedAt: minutesAgo(10),
    }
    update([...inboxSessions, arrival, older])
    expect(live).toHaveTextContent(/^Aster, Fifth, waiting for your input$/)
    update([...inboxSessions.slice(1), arrival, older])
    expect(live).toHaveTextContent(/^Aster, Fifth, waiting for your input$/)
  })

  it("lists a muted Agent's rows last, and Mark all read covers them", async () => {
    const user = userEvent.setup()
    const quiet = { id: "q", name: "Quill", muted: true as const }
    const { provider } = renderInbox(
      [
        inboxSessions[1]!,
        {
          sessionId: "quiet",
          agentId: "q",
          status: "idle",
          updatedAt: minutesAgo(1),
          unread: true,
        },
      ],
      [quiet]
    )
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map(({ textContent }) => textContent?.replace(/ \d+$/, ""))
    ).toEqual(["Waiting for you", "Muted"])
    await user.click(screen.getByRole("button", { name: "Mark all read" }))
    expect(
      provider.markSessionRead.mock.calls.map(([sessionId]) => sessionId)
    ).toEqual(["quiet"])
  })

  it("shows one calm message while nothing needs the operator", () => {
    const provider = source()
    function Harness() {
      const activity = useActivityCoordinator({
        ...options(provider.workspace),
        sessions: [sessions[0]!],
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
    expect(screen.getByText(en.activity.emptyTitle)).toBeVisible()
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull()
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled()
  })
})

describe("an Agent the creator made", () => {
  const sora = {
    kind: "ready",
    id: "agent-sora",
    name: "Sora",
    description: "Trip planning",
  } as const
  /** The panel over a fixture whose creator has just made Sora. */
  async function renderCreation() {
    const workspace = createFixtureWorkspace({
      clock: () => now,
      // One read Session the creator does not own, and nothing unread.
      sessions: [
        {
          sessionId: "thread-mica-quarterly",
          agentId: "agent-mica",
          status: "idle",
          updatedAt: now.toISOString(),
          unread: false,
        },
      ],
    })
    const interview = await workspace.createSession("agent-builder")
    const sessions = workspace.listAllSessionMetadata()
    const onOpenAgent = vi.fn<(agentId: string) => Promise<void>>(
      async () => {}
    )
    function Harness({ agents }: { agents: AgentSummary[] }) {
      const activity = useActivityCoordinator({
        workspace,
        agents,
        sessions,
        titles: new Map(),
        selection: null,
        locale: "en",
        readNow: () => now,
        onOpenTarget: async () => {},
        onOpenAgent,
        onActionError: () => {},
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
    const view = render(<Harness agents={await workspace.listAgents()} />)
    await act(async () =>
      workspace.completeAgentCreation(interview.sessionId, sora)
    )
    // The catalog now lists Sora, as the navigation's refresh reads it.
    view.rerender(<Harness agents={await workspace.listAgents()} />)
    return { workspace, onOpenAgent }
  }
  const readyRow = () =>
    screen.queryByRole("button", { name: "Sora is ready, Trip planning, now" })

  it("lists it as ready, and opens it as an Agent with no Session yet", async () => {
    const user = userEvent.setup()
    const { onOpenAgent } = await renderCreation()

    await user.click(readyRow()!)

    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith("agent-sora")
    await waitFor(() => expect(readyRow()).toBeNull())
  })

  it("clears its row when marked read, and Mark all read covers it", async () => {
    const user = userEvent.setup()
    await renderCreation()
    await user.click(
      screen.getByRole("button", { name: "Mark read: Sora, Trip planning" })
    )
    expect(readyRow()).toBeNull()

    cleanup()
    await renderCreation()
    const markAll = screen.getByRole("button", { name: "Mark all read" })
    await user.click(markAll)
    expect(readyRow()).toBeNull()
    expect(markAll).toBeDisabled()
  })

  it("lists nothing a Session the creator does not own reports", async () => {
    const { workspace } = await renderCreation()
    await act(async () => workspace.publishActivityScenario("agent-ready"))
    expect(screen.queryByRole("button", { name: /^Mica is ready/ })).toBeNull()
    expect(readyRow()).not.toBeNull()
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

  it("asks an uninstalled iPhone to install AOS, and stays dismissible", async () => {
    const user = userEvent.setup()
    const onDeclineAsk = vi.fn()
    // Such a tab exposes no Notification API at all, which is what turns the
    // ask into an install hint rather than a permission request.
    Reflect.deleteProperty(window, "Notification")
    render(
      <ActivityAsk
        dictionary={en}
        settings={browserSettings({
          ask: true,
          push: "available",
          iosInstallHint: true,
          onDeclineAsk,
        })}
      />
    )

    expect(screen.getByText(en.activity.pushIosHint)).toBeVisible()
    expect(screen.queryByText(en.activity.askClosed)).toBeNull()
    // There is nothing to turn on yet, but the ask must still be answerable.
    expect(
      screen.queryByRole("button", { name: en.activity.askAccept })
    ).toBeNull()
    await user.click(
      screen.getByRole("button", { name: en.activity.askDecline })
    )
    expect(onDeclineAsk).toHaveBeenCalledOnce()
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
