// @vitest-environment node

import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"

import {
  SessionHistoryResponseSchema,
  SessionSchema,
  type Session,
} from "../../protocol"
import type { ProxyAppOptions } from "../app"
import type { RuntimeInstance, ServerRuntime } from "../core/runtime"
import type { SessionExecutionState } from "../core/session-coordinator"
import { registerSessionRoutes } from "./sessions"
import type { ProxyRouteApp } from "./types"

const SESSION_URL =
  "http://proxy.test/api/aos/v1/agents/researcher/sessions/stored"

function storedSession(status: Session["status"]): Session {
  return {
    id: "stored",
    agentId: "researcher",
    title: "Owned",
    archived: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status,
  }
}

/**
 * The two public paths that answer with a Session status: the Session read and
 * the history load, both observing one coordinator execution.
 */
function sessionRoutes(
  state: SessionExecutionState,
  providerStatus: Session["status"] = "idle"
) {
  const runtime = {
    resolveSessionId: (_agentId: string, publicSessionId: string) =>
      publicSessionId === "stored" ? "stored" : undefined,
    getSession: vi.fn(async () => storedSession(providerStatus)),
    history: vi.fn(async () => ({
      sessionId: "stored",
      messages: [],
      total: 0,
      limit: 200,
      offset: 0,
      nextOffset: 0,
    })),
  } as unknown as ServerRuntime
  const options = {
    publicOrigin: "http://proxy.test",
    runtimeInstance: {
      id: "runtime-main",
      runtime,
      sessions: {
        state: () => state,
        snapshot: () => ({ state, runId: "run-1", interrupts: [] }),
        discover: vi.fn(async () => undefined),
      },
      close: vi.fn(async () => undefined),
    } as unknown as RuntimeInstance,
    logger: { info: vi.fn(), error: vi.fn() },
  } as ProxyAppOptions
  const app = new Hono<{ Variables: { requestId: string } }>()
  registerSessionRoutes(app as ProxyRouteApp, options, async () => runtime)
  return {
    read: async () =>
      SessionSchema.parse(await (await app.request(SESSION_URL)).json()).status,
    history: async () =>
      SessionHistoryResponseSchema.parse(
        await (await app.request(`${SESSION_URL}/history`)).json()
      ).execution?.status,
  }
}

describe("public Session status", () => {
  it.each([
    ["idle", "idle"],
    ["running", "running"],
    ["stopping", "running"],
    ["waiting-for-input", "waiting-for-input"],
    ["uncertain", "failed"],
  ] satisfies Array<[SessionExecutionState, Session["status"]]>)(
    "reports %s execution as %s on both the Session read and the history load",
    async (state, expected) => {
      const routes = sessionRoutes(state)

      expect(await routes.read()).toBe(expected)
      expect(await routes.history()).toBe(expected)
    }
  )

  it("keeps the provider status on a Session read while no execution is observed", async () => {
    const routes = sessionRoutes("idle", "failed")

    expect(await routes.read()).toBe("failed")
    expect(await routes.history()).toBe("idle")
  })
})
