// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { createReconnectCursorCodec } from "./cursor"
import { createOperatorEventService } from "./service"

const scope = {
  workspaceId: "operator",
  agentId: "researcher",
  sessionId: "hermes:researcher:stored",
}

describe("authenticated operator event service", () => {
  it("authorizes the upgrade before exact Session observation", async () => {
    const stop = vi.fn()
    const getSession = vi.fn(async () => ({
      id: scope.sessionId,
      agentId: scope.agentId,
    }))
    const observe = vi.fn(async () => stop)
    const resume = vi.fn(async () => ({ liveSessionId: "live-session" }))
    const operatorSession = vi.fn(async () => ({
      principalId: "aos_principal_operator",
      sessionId: "browser-session",
      issuedAt: 1,
      expiresAt: 901,
    }))
    const service = createOperatorEventService({
      publicOrigin: "https://aos.example.test",
      deploymentId: "production-a",
      bootEpoch: "boot-1",
      cursor: createReconnectCursorCodec({
        activeKeyId: "current",
        keys: { current: new Uint8Array(32).fill(7) },
        now: () => 1,
      }),
      operatorSession,
      runtimeState: vi.fn(() => ({ status: "authenticated" })),
      hermesForOperator: vi.fn(() => ({ getSession, resume, observe })),
      now: () => 1_000,
    })

    await expect(
      service.authorizeUpgrade(
        new Request("https://aos.example.test/api/aos/v1/events", {
          headers: { origin: "https://attacker.example.test" },
        })
      )
    ).resolves.toBeUndefined()
    expect(operatorSession).not.toHaveBeenCalled()

    const upgrade = await service.authorizeUpgrade(
      new Request("https://aos.example.test/api/aos/v1/events", {
        headers: {
          origin: "https://aos.example.test",
          cookie: "__Host-aos-session=sealed",
        },
      })
    )
    expect(upgrade).toBeDefined()
    const sent: unknown[] = []
    const socket = service.open(upgrade!, {
      send: (raw) => sent.push(JSON.parse(raw)),
      close: vi.fn(),
    })
    await socket.receive(
      JSON.stringify({ type: "aos.subscribe", streamId: "stream-1", scope })
    )

    expect(getSession).toHaveBeenCalledWith("researcher", "stored")
    expect(resume).toHaveBeenCalledWith({
      agentId: "researcher",
      sessionId: "stored",
      threadId: scope.sessionId,
    })
    expect(observe).toHaveBeenCalledWith(
      "live-session",
      expect.any(Function),
      expect.any(Function)
    )
    expect(observe).toHaveBeenCalledTimes(1)
    expect(sent).toMatchObject([
      {
        type: "aos.ready",
        streamId: "stream-1",
        scope,
        read: "authoritative",
      },
    ])
    const ready = sent[0] as { cursor: string }
    expect(ready.cursor).toEqual(expect.any(String))
    socket.close()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("rejects cross-owner and runtime-unauthenticated scopes before observation", async () => {
    const getSession = vi.fn(async () => {
      throw new Error("wrong owner")
    })
    const observe = vi.fn()
    const resume = vi.fn()
    const service = createOperatorEventService({
      publicOrigin: "https://aos.example.test",
      deploymentId: "production-a",
      bootEpoch: "boot-1",
      cursor: createReconnectCursorCodec({
        activeKeyId: "current",
        keys: { current: new Uint8Array(32).fill(7) },
        now: () => 1,
      }),
      operatorSession: vi.fn(async () => ({
        principalId: "aos_principal_operator",
        sessionId: "browser-session",
        issuedAt: 1,
        expiresAt: 901,
      })),
      runtimeState: vi.fn(() => ({ status: "authentication-required" })),
      hermesForOperator: vi.fn(() => ({ getSession, resume, observe })),
      now: () => 1_000,
    })
    const upgrade = await service.authorizeUpgrade(
      new Request("https://aos.example.test/api/aos/v1/events", {
        headers: { origin: "https://aos.example.test" },
      })
    )
    const sent: unknown[] = []
    const socket = service.open(upgrade!, {
      send: (raw) => sent.push(JSON.parse(raw)),
      close: vi.fn(),
    })
    await socket.receive(
      JSON.stringify({ type: "aos.subscribe", streamId: "stream-1", scope })
    )

    expect(sent).toEqual([
      {
        type: "aos.error",
        version: 1,
        streamId: "stream-1",
        code: "unauthorized",
      },
    ])
    expect(getSession).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
  })

  it("rejects sentinel control and catalog identifiers as non-Session scopes", async () => {
    const getSession = vi.fn()
    const observe = vi.fn()
    const resume = vi.fn()
    const service = createOperatorEventService({
      publicOrigin: "https://aos.example.test",
      deploymentId: "production-a",
      bootEpoch: "boot-1",
      cursor: createReconnectCursorCodec({
        activeKeyId: "current",
        keys: { current: new Uint8Array(32).fill(7) },
        now: () => 1,
      }),
      operatorSession: vi.fn(async () => ({
        principalId: "aos_principal_operator",
        sessionId: "browser-session",
        issuedAt: 1,
        expiresAt: 901,
      })),
      runtimeState: vi.fn(() => ({ status: "authenticated" })),
      hermesForOperator: vi.fn(() => ({ getSession, resume, observe })),
      now: () => 1_000,
    })
    const upgrade = await service.authorizeUpgrade(
      new Request("https://aos.example.test/api/aos/v1/events", {
        headers: { origin: "https://aos.example.test" },
      })
    )
    const sent: Array<{ code: string }> = []
    const socket = service.open(upgrade!, {
      send: (raw) => sent.push(JSON.parse(raw)),
      close: vi.fn(),
    })

    for (const invalidScope of [
      { workspaceId: "operator", agentId: "aos", sessionId: "runtime" },
      {
        workspaceId: "operator",
        agentId: "researcher",
        sessionId: "catalog",
      },
    ])
      await socket.receive(
        JSON.stringify({
          type: "aos.subscribe",
          streamId: `stream-${invalidScope.sessionId}`,
          scope: invalidScope,
        })
      )

    expect(getSession).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(sent.map(({ code }) => code)).toEqual([
      "unauthorized",
      "unauthorized",
    ])
  })
})
