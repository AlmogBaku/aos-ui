// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import type { Session } from "../../protocol"
import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import { createCatalog } from "./catalog"
import * as ids from "./ids"
import { READY_LINK } from "./link"
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
    held?: Session
    state?: SessionExecutionState
    updateSession?: () => Promise<void>
    subscribeCatalogChanges?: ServerRuntime["subscribeCatalogChanges"]
  } = {}
) {
  const updateSession = vi.fn(options.updateSession ?? (async () => undefined))
  // The runtime surface is wide; these tests reach for the list, the row, and
  // the change feed.
  const runtime = {
    publicError: () => undefined,
    link: READY_LINK,
    subscribeCatalogChanges: options.subscribeCatalogChanges,
    resolveProviderSessionId: (_agentId: string, publicId: string) =>
      `stored-${publicId}`,
    listAllSessions: async (limit: number, offset: number) => ({
      sessions: [options.listed ?? row()],
      total: 1,
      limit,
      offset,
    }),
    getSession: async () => options.held ?? options.listed ?? row(),
    updateSession,
  } as unknown as ServerRuntime
  const rows = createSessionRows()
  const catalog = createCatalog({
    runtime,
    coordinator: { state: () => options.state ?? "idle" },
    rows,
    logger: captureLogs().logger,
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

  it("shows a member of a listed Session its listed row at once, then the one the provider holds now", async () => {
    const { catalog } = harness({ held: row({ title: "Renamed elsewhere" }) })
    await catalog.list(undefined, 0)
    const titles: string[] = []

    catalog.subscribe(
      {
        agentId: AGENT,
        sessionId: ids.sessionId(SESSION),
        providerSessionId: ids.providerSessionId(`stored-${SESSION}`),
      },
      ({ title }) => titles.push(title),
      () => undefined
    )
    await Promise.resolve()

    expect(titles).toEqual(["Weekly digest", "Renamed elsewhere"])
  })

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

  it("starts the runtime's change feed again when it fails to start", async () => {
    const clock = useFakeClock()
    const subscribeCatalogChanges = vi
      .fn<NonNullable<ServerRuntime["subscribeCatalogChanges"]>>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValue(() => undefined)
    const { catalog } = harness({ subscribeCatalogChanges })
    const listener = vi.fn()

    catalog.invalidation.subscribe(listener)
    await clock.advance(250)

    expect(subscribeCatalogChanges).toHaveBeenCalledTimes(2)
    subscribeCatalogChanges.mock.calls[1]![0]()
    expect(listener).toHaveBeenCalledOnce()
  })
})
