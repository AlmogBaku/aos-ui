// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import type { RuntimeInstance, ServerRuntime } from "../core/runtime"
import { createReconnectCursorCodec } from "./cursor"
import { createOperatorEventService } from "./service"

const scope = {
  workspaceId: "operator",
  agentId: "researcher",
  sessionId: "stored",
}

function runtimeInstance(runtime: Partial<ServerRuntime>): RuntimeInstance {
  return {
    id: "hermes-main",
    runtime: runtime as ServerRuntime,
    sessions: {} as RuntimeInstance["sessions"],
    close: vi.fn(),
  }
}

function service(runtime: Partial<ServerRuntime>) {
  return createOperatorEventService({
    publicOrigin: "https://aos.example.test",
    deploymentId: "production-a",
    bootEpoch: "boot-1",
    cursor: createReconnectCursorCodec({
      activeKeyId: "current",
      keys: { current: new Uint8Array(32).fill(7) },
      now: () => 1,
    }),
    runtimeInstance: runtimeInstance(runtime),
    now: () => 1_000,
  })
}

describe("trusted operator event service", () => {
  it("requires the exact operator origin but no cookie", async () => {
    const eventService = service({})

    await expect(
      eventService.authorizeUpgrade(
        new Request("https://aos.example.test/api/aos/v1/events", {
          headers: { origin: "https://attacker.example.test" },
        })
      )
    ).resolves.toBeUndefined()
    await expect(
      eventService.authorizeUpgrade(
        new Request("https://aos.example.test/api/aos/v1/events", {
          headers: { origin: "https://aos.example.test" },
        })
      )
    ).resolves.toEqual({
      principalId: "operator",
      authorizationRevision: "trusted-listener",
    })
  })

  it("authorizes ownership and subscribes through the shared runtime", async () => {
    const stop = vi.fn()
    const getSession = vi.fn(async () => ({
      id: scope.sessionId,
      agentId: scope.agentId,
    }))
    const subscribeSessionInvalidation = vi.fn(async () => stop)
    const eventService = service({
      resolveSessionId: vi.fn(() => "stored"),
      getSession,
      subscribeSessionInvalidation,
    })
    const upgrade = await eventService.authorizeUpgrade(
      new Request("https://aos.example.test/api/aos/v1/events", {
        headers: { origin: "https://aos.example.test" },
      })
    )
    const sent: unknown[] = []
    const socket = eventService.open(upgrade!, {
      send: (raw) => sent.push(JSON.parse(raw)),
      close: vi.fn(),
    })
    await socket.receive(
      JSON.stringify({ type: "aos.subscribe", streamId: "stream-1", scope })
    )

    expect(getSession).toHaveBeenCalledWith("researcher", "stored")
    expect(subscribeSessionInvalidation).toHaveBeenCalledWith(
      "researcher",
      "stored",
      expect.any(Function),
      expect.any(Function)
    )
    expect(sent).toMatchObject([
      {
        type: "aos.ready",
        streamId: "stream-1",
        scope,
        read: "authoritative",
      },
    ])
    socket.close()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("rejects cross-owner and sentinel scopes before observation", async () => {
    const getSession = vi.fn(async () => {
      throw new Error("wrong owner")
    })
    const subscribeSessionInvalidation = vi.fn()
    const eventService = service({
      resolveSessionId: vi.fn((agentId, sessionId) =>
        agentId === "aos" || sessionId === "catalog" ? undefined : "stored"
      ),
      getSession,
      subscribeSessionInvalidation,
    })
    const upgrade = await eventService.authorizeUpgrade(
      new Request("https://aos.example.test/api/aos/v1/events", {
        headers: { origin: "https://aos.example.test" },
      })
    )

    for (const invalidScope of [
      scope,
      { workspaceId: "operator", agentId: "aos", sessionId: "runtime" },
      {
        workspaceId: "operator",
        agentId: "researcher",
        sessionId: "catalog",
      },
    ]) {
      const sent: Array<{ code?: string }> = []
      const socket = eventService.open(upgrade!, {
        send: (raw) => sent.push(JSON.parse(raw)),
        close: vi.fn(),
      })
      await socket.receive(
        JSON.stringify({
          type: "aos.subscribe",
          streamId: `stream-${invalidScope.agentId}-${invalidScope.sessionId}`,
          scope: invalidScope,
        })
      )
      expect(sent[0]?.code).toBe("unauthorized")
      socket.close()
    }
    expect(subscribeSessionInvalidation).not.toHaveBeenCalled()
  })
})
