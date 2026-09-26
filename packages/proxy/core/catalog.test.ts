// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import type { Session } from "../../protocol"
import { createCatalog } from "./catalog"
import type { ServerRuntime } from "./runtime"
import type { SessionExecutionState } from "./session-coordinator"
import { createSessionRows } from "./session-rows"

const AGENT = "researcher"
const SESSION = "session-1"

function row(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    agentId: AGENT,
    title: "Weekly digest",
    archived: false,
    updatedAt: "2026-09-19T10:00:00.000Z",
    status: "idle",
    ...overrides,
  }
}

function harness(
  options: {
    listed?: Session
    state?: SessionExecutionState
    updateSession?: () => Promise<void>
  } = {}
) {
  const updateSession = vi.fn(options.updateSession ?? (async () => undefined))
  // The runtime surface is wide; these tests reach for the list and the row.
  const runtime = {
    resolveProviderSessionId: (_agentId: string, publicId: string) =>
      `stored-${publicId}`,
    listAllSessions: async (limit: number, offset: number) => ({
      sessions: [options.listed ?? row()],
      total: 1,
      limit,
      offset,
    }),
    updateSession,
  } as unknown as ServerRuntime
  const rows = createSessionRows()
  const catalog = createCatalog({
    runtime,
    coordinator: { state: () => options.state ?? "idle" },
    rows,
  })
  return { catalog, rows, updateSession }
}

describe("createCatalog", () => {
  it.each([
    // No live execution: the provider's settled answer stands.
    ["idle", "failed", "failed"],
    ["idle", "waiting-for-input", "waiting-for-input"],
    // A live execution outranks it.
    ["running", "failed", "running"],
    ["stopping", "idle", "running"],
    ["waiting-for-input", "idle", "waiting-for-input"],
    ["uncertain", "idle", "failed"],
  ] satisfies Array<
    [SessionExecutionState, Session["status"], Session["status"]]
  >)(
    "lists a %s Session the provider reports %s as %s",
    async (state, settled, shown) => {
      const { catalog } = harness({ state, listed: row({ status: settled }) })

      const { rows } = await catalog.list(undefined, 0)

      expect(rows.map(({ status }) => status)).toEqual([shown])
    }
  )

  it("keeps the optimistic read row when the provider rejects the write", async () => {
    const { catalog, rows, updateSession } = harness({
      updateSession: async () => {
        throw new Error("Session not found")
      },
    })
    rows.rememberList([row({ unread: true })])

    await expect(catalog.markRead(AGENT, SESSION)).resolves.toBeUndefined()

    expect(updateSession).toHaveBeenCalledWith(AGENT, `stored-${SESSION}`, {
      unread: false,
    })
    expect(rows.get(AGENT, SESSION)?.unread).toBe(false)
  })
})
