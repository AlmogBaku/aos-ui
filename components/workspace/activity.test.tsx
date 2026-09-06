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
  WorkspaceActivityEvent,
  WorkspaceAdapter,
  SessionMetadata,
} from "@/lib/runtime-adapters/contracts"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { useActivityCoordinator } from "./use-activity-coordinator"
import {
  ActivityPanel,
  ActivityBell,
  ActivityNotice,
  ActivitySettings,
} from "./activity"

const now = new Date("2026-09-05T12:00:00Z")
const sessions: SessionMetadata[] = ["one", "two"].map((threadId) => ({
  threadId,
  agentId: threadId === "one" ? "a" : "b",
  status: "idle",
  updatedAt: now.toISOString(),
}))
const agents = [
  { id: "a", name: "Aster" },
  { id: "b", name: "Mica" },
]
function source() {
  let receive: (event: WorkspaceActivityEvent) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const unsubscribe = vi.fn()
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
  }
}
function options(workspace: WorkspaceAdapter) {
  return {
    workspace,
    agents,
    sessions,
    titles: new Map([
      ["one", "First"],
      ["two", "Second"],
    ]),
    selection: { agentId: "a", threadId: "one" },
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
    act(() => result.current.markAllRead())
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
    expect(result.current.items[0]).toMatchObject({
      read: true,
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
      read: true,
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
    expect(result.current.notice).toEqual({ count: 2, urgent: true })
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
    "keeps %s arrivals unread without a notice, then reads the selected Session on focus",
    async (state) => {
      const provider = source()
      const focus = vi.mocked(document.hasFocus)
      if (state === "hidden")
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
      else focus.mockReturnValue(false)
      const { result } = renderHook(useActivityCoordinator, {
        initialProps: options(provider.workspace),
      })
      act(() => provider.emit("event", "one"))
      await waitFor(() => expect(result.current.items).toHaveLength(1))
      expect(result.current.items[0]!.read).toBe(false)
      expect(result.current.notice).toBeNull()
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
      focus.mockReturnValue(true)
      act(() => window.dispatchEvent(new Event("focus")))
      expect(result.current.items[0]!.read).toBe(true)
    }
  )
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
  it("validates and opens the owning Agent and Session then marks read", async () => {
    const provider = source()
    const props = options(provider.workspace)
    const { result } = renderHook(useActivityCoordinator, {
      initialProps: props,
    })
    act(() => provider.emit("event"))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    await act(async () => {
      expect(await result.current.openActivity("event")).toBe(true)
    })
    expect(props.onOpenTarget).toHaveBeenCalledWith("b", "two")
    expect(result.current.items[0]!.read).toBe(true)
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
  it("offers attention/history, marks all read, and keeps unavailable entries inspectable", async () => {
    const user = userEvent.setup()
    const provider = source()
    const props = options(provider.workspace)
    function Harness() {
      const activity = useActivityCoordinator(props)
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
    render(
      <ActivitySettings
        dictionary={en}
        settings={{
          status: "default",
          coverage: "active-session",
          preferences: {
            enabled: false,
            completion: true,
            failure: true,
            input: true,
          },
          onEnabledChange,
          onCategoryChange,
        }}
      />
    )
    expect(onEnabledChange).not.toHaveBeenCalled()
    expect(screen.getByText(/active Session only/)).toBeVisible()
    await user.click(
      screen.getByRole("checkbox", { name: "Browser notifications" })
    )
    expect(onEnabledChange).toHaveBeenCalledWith(true)
    await user.click(screen.getByRole("checkbox", { name: "Turn completions" }))
    expect(onCategoryChange).toHaveBeenCalledWith("completion", false)
  })
})
