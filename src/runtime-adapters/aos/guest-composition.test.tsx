import { describe, expect, it, vi } from "vitest"

import {
  authorizeGuestEvents,
  guestEventSocket,
  parseGuestInvitationScope,
} from "./guest-composition"

function invitation(payload: unknown) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "")
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`
}

describe("AOS guest browser composition", () => {
  it("uses only bounded invitation routing claims and the configured lane", () => {
    const token = invitation({
      agent: "researcher",
      session: "hermes:researcher:stored-session",
      operatorToken: "must-not-be-consumed",
    })

    expect(parseGuestInvitationScope(token, "guest")).toEqual({
      workspaceId: "guest",
      agentId: "researcher",
      sessionId: "hermes:researcher:stored-session",
    })
    expect(parseGuestInvitationScope("malformed", "guest")).toBeUndefined()
    expect(
      parseGuestInvitationScope(
        invitation({ agent: "researcher", session: "" }),
        "guest"
      )
    ).toBeUndefined()
  })

  it("exchanges the bearer for a socket cookie before opening the scoped WebSocket", async () => {
    const calls: string[] = []
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`fetch:${String(input)}`)
        expect(init).toMatchObject({
          method: "POST",
          credentials: "same-origin",
        })
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer invitation.jwt"
        )
        return new Response(null, { status: 204 })
      }
    )
    const sockets: string[] = []
    class BrowserSocket extends EventTarget {
      readyState = 0
      constructor(readonly url: string) {
        super()
        sockets.push(url)
        calls.push(`socket:${url}`)
      }
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", BrowserSocket)
    const scope = {
      workspaceId: "guest",
      agentId: "researcher",
      sessionId: "hermes:researcher:stored-session",
    }

    await authorizeGuestEvents(
      fetcher,
      "/api/guest/v1",
      "Bearer invitation.jwt",
      scope
    )
    guestEventSocket("/api/guest/v1", scope)

    expect(calls).toEqual([
      "fetch:/api/guest/v1/events/authorize?agentId=researcher&sessionId=hermes%3Aresearcher%3Astored-session",
      "socket:ws://localhost:3000/api/guest/v1/events?agentId=researcher&sessionId=hermes%3Aresearcher%3Astored-session",
    ])
    expect(sockets).toHaveLength(1)
    vi.unstubAllGlobals()
  })
})
