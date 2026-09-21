import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { AssistantRuntime } from "@assistant-ui/react"

import { en } from "@/lib/i18n/dictionaries/en"
import type {
  AgentSummary,
  SessionMetadata,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import { useWorkspaceNavigation } from "./use-workspace-navigation"

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: window.location.pathname }),
  useNavigate: () => (href: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"](
      null,
      "",
      href
    )
  },
}))

beforeEach(() => window.history.replaceState({}, "", "/"))
afterEach(cleanup)

const NOW = new Date("2026-09-08T10:00:00.000Z")
const agent: AgentSummary = { kind: "ready", id: "agent-a", name: "Aster" }
const recent: SessionMetadata = {
  threadId: "s-recent",
  agentId: "agent-a",
  updatedAt: "2026-09-08T09:30:00.000Z",
  status: "idle",
}
const old: SessionMetadata = {
  threadId: "s-old",
  agentId: "agent-a",
  updatedAt: "2026-09-01T09:00:00.000Z",
  status: "idle",
}

type FakeItem = {
  id: string
  remoteId?: string
  title?: string
  status: "new" | "regular" | "archived"
}

/**
 * The smallest thread list the hook can drive: mutations stay pending until the
 * test releases them, so what the hook does *before* a mutation settles is
 * observable.
 */
function createFakeThreadList(threadIds: readonly string[]) {
  const log: string[] = []
  const pending = new Map<string, () => void>()
  const listeners = new Set<() => void>()
  const items = new Map<string, FakeItem>(
    threadIds.map((id) => [
      id,
      { id, remoteId: id, title: id, status: "regular" },
    ])
  )
  let mainThreadId = "draft-0"
  let drafts = 0
  items.set(mainThreadId, { id: mainThreadId, status: "new" })

  const snapshot = () => ({
    mainThreadId,
    newThreadId: undefined,
    threadIds: [...items.values()]
      .filter((item) => item.status === "regular")
      .map((item) => item.id),
    archivedThreadIds: [...items.values()]
      .filter((item) => item.status === "archived")
      .map((item) => item.id),
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    threadItems: Object.fromEntries(items),
  })
  let state = snapshot()
  const notify = () => {
    state = snapshot()
    for (const listener of listeners) listener()
  }
  const gate = (action: string, apply: () => void) => {
    log.push(action)
    return new Promise<void>((resolve) => {
      pending.set(action, () => {
        apply()
        notify()
        resolve()
      })
    })
  }

  const threads = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    switchToThread: async (threadId: string) => {
      log.push(`switch:${threadId}`)
      mainThreadId = threadId
      notify()
    },
    switchToNewThread: async () => {
      drafts += 1
      mainThreadId = `draft-${drafts}`
      items.set(mainThreadId, { id: mainThreadId, status: "new" })
      log.push("switch:new")
      notify()
    },
    reload: async () => {
      log.push("reload")
      notify()
    },
    getItemById: (threadId: string) => ({
      rename: (title: string) =>
        gate(`rename:${threadId}`, () => {
          const item = items.get(threadId)
          if (item) item.title = title
        }),
      archive: () =>
        gate(`archive:${threadId}`, () => {
          const item = items.get(threadId)
          if (item) item.status = "archived"
        }),
      unarchive: () =>
        gate(`unarchive:${threadId}`, () => {
          const item = items.get(threadId)
          if (item) item.status = "regular"
        }),
      // Provider metadata can still list a deleted Session for a moment.
      delete: () => gate(`delete:${threadId}`, () => {}),
    }),
  }

  return {
    log,
    release: (action: string) => {
      const resolve = pending.get(action)
      pending.delete(action)
      resolve?.()
    },
    runtime: { threads } as unknown as AssistantRuntime,
  }
}

function createWorkspace(
  sessions: readonly SessionMetadata[],
  overrides: Partial<WorkspaceAdapter> = {}
): WorkspaceAdapter {
  return {
    listAgents: async () => [agent],
    refreshAgents: async () => [agent],
    getSessionMetadata: async (threadIds) =>
      sessions.filter(({ threadId }) => threadIds.includes(threadId)),
    createSession: async () => ({ threadId: "unused" }),
    sessionActionCapabilities: async () => ({
      rename: true,
      archive: true,
      delete: true,
      pin: true,
    }),
    ...overrides,
  }
}

async function mountNavigation(
  threadIds: readonly string[],
  sessions: readonly SessionMetadata[],
  overrides?: Partial<WorkspaceAdapter>
) {
  const threadList = createFakeThreadList(threadIds)
  const workspace = createWorkspace(sessions, overrides)
  const { result } = renderHook(() =>
    useWorkspaceNavigation({
      bundle: { assistantRuntime: threadList.runtime, workspace },
      locale: "en",
      dictionary: en,
      now: NOW,
      readNow: () => NOW,
    })
  )
  await waitFor(() => expect(result.current.visibleThreadId).toBe("s-recent"))
  return { ...threadList, result, workspace }
}

it("leaves an archived Session behind before the provider confirms", async () => {
  const { result, log, release } = await mountNavigation(
    ["s-recent", "s-old"],
    [recent, old]
  )
  await act(async () => {
    await result.current.openSession("s-old")
  })
  expect(result.current.visibleThreadId).toBe("s-old")

  let settled = false
  await act(async () => {
    void result.current.archiveSession("s-old").then(() => {
      settled = true
    })
  })

  // Selection reached the neighbour while the archive was still in flight.
  expect(settled).toBe(false)
  expect(log.indexOf("switch:s-recent")).toBeLessThan(
    log.indexOf("archive:s-old")
  )
  expect(result.current.visibleThreadId).toBe("s-recent")
  expect(window.location.pathname).toBe("/agent-a/s-recent")

  await act(async () => {
    release("archive:s-old")
  })
  await waitFor(() => expect(settled).toBe(true))
  await waitFor(() =>
    expect(
      result.current.sessionView.openSessions.map(({ threadId }) => threadId)
    ).toEqual(["s-recent"])
  )
})

it("opens a new Session when an archived Session has no neighbour", async () => {
  const { result, log, release } = await mountNavigation(["s-recent"], [recent])

  let settled = false
  await act(async () => {
    void result.current.archiveSession("s-recent").then(() => {
      settled = true
    })
  })

  expect(settled).toBe(false)
  expect(log.indexOf("switch:new")).toBeLessThan(
    log.indexOf("archive:s-recent")
  )
  expect(result.current.visibleThreadId).toBeNull()
  expect(window.location.pathname).toBe("/agent-a")

  await act(async () => {
    release("archive:s-recent")
  })
  await waitFor(() => expect(settled).toBe(true))
  expect(result.current.sessionView.openSessions).toEqual([])
})

it("keeps no tab for a deleted Session provider metadata still lists", async () => {
  const { result, log, release } = await mountNavigation(
    ["s-recent", "s-old"],
    [recent, old]
  )
  await act(async () => {
    await result.current.openSession("s-old")
  })
  expect(
    result.current.sessionView.openSessions.map(({ threadId }) => threadId)
  ).toEqual(["s-recent", "s-old"])

  let settled = false
  await act(async () => {
    void result.current.deleteSession("s-old").then(() => {
      settled = true
    })
  })
  expect(settled).toBe(false)
  expect(log.indexOf("switch:s-recent")).toBeLessThan(
    log.indexOf("delete:s-old")
  )

  await act(async () => {
    release("delete:s-old")
  })
  await waitFor(() => expect(settled).toBe(true))
  await waitFor(() =>
    expect(
      result.current.sessionView.openSessions.map(({ threadId }) => threadId)
    ).toEqual(["s-recent"])
  )
})

it("returns a closed pinned tab once its Session is active again", async () => {
  const pinned: SessionMetadata = {
    threadId: "s-pinned",
    agentId: "agent-a",
    updatedAt: "2026-09-01T09:00:00.000Z",
    status: "idle",
    pinned: true,
  }
  let publishSessions: (metadata: SessionMetadata[]) => void = () => {}
  const { result } = await mountNavigation(
    ["s-recent", "s-pinned"],
    [recent, pinned],
    {
      subscribeSessionMetadata: (_threadIds, listener) => {
        publishSessions = listener
        return () => {}
      },
    }
  )
  const openTabs = () =>
    result.current.shellOpenSessions.map(({ threadId }) => threadId)
  // The pin keeps a week-old Session open, and leading.
  await waitFor(() => expect(openTabs()).toEqual(["s-pinned", "s-recent"]))

  await act(async () => {
    await result.current.closeSession("s-pinned")
  })
  expect(openTabs()).toEqual(["s-recent"])

  await act(() => {
    publishSessions([
      recent,
      { ...pinned, updatedAt: "2026-09-08T09:45:00.000Z" },
    ])
  })
  await waitFor(() => expect(openTabs()).toEqual(["s-pinned", "s-recent"]))
})

it("reports the Session actions the runtime declares, and none otherwise", async () => {
  const declared = await mountNavigation(["s-recent"], [recent])
  await waitFor(() =>
    expect(declared.result.current.sessionActions).toEqual({
      rename: true,
      archive: true,
      delete: true,
      pin: true,
    })
  )

  const silent = await mountNavigation(["s-recent"], [recent], {
    sessionActionCapabilities: undefined,
  })
  expect(silent.result.current.sessionActions).toEqual({
    rename: false,
    archive: false,
    delete: false,
    pin: false,
  })
})

it("renames through the thread list and pins through the provider", async () => {
  const setSessionPinned = vi.fn(async () => {})
  const { result, log, release } = await mountNavigation(
    ["s-recent"],
    [recent],
    { setSessionPinned }
  )

  await act(async () => {
    const renamed = result.current.renameSession("s-recent", "Weekly brief")
    release("rename:s-recent")
    await renamed
  })
  expect(log).toContain("rename:s-recent")

  await act(async () => {
    await result.current.setSessionPinned("s-recent", true)
  })
  expect(setSessionPinned).toHaveBeenCalledWith("s-recent", true)
})
