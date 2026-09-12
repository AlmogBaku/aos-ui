import { describe, expect, it, vi } from "vitest"

import { createProxyApp } from "./app"
import { HermesServerAdapter } from "./hermes-adapter"
import { HermesHttpError } from "./hermes-transport"
import { createOperatorAuthenticator } from "./operator-auth"

const origin = "http://127.0.0.1:3000"

function nativeProfile(hidden = false, revision = 7) {
  return {
    name: "researcher",
    display_name: "Researcher",
    ui_meta: { "hermes-bots": { hidden } },
    ui_meta_revisions: { "hermes-bots": revision },
  }
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://proxy.test${path}`, {
    ...init,
    headers: {
      cookie: "aos_operator=valid",
      ...init.headers,
    },
  })
}

describe("AOS v1 proxy walking skeleton", () => {
  it("serves the complete normalized Session lifecycle without native identity disclosure", async () => {
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === "profiles.list") return { profiles: [nativeProfile()] }
      if (method === "session.create")
        return { session_id: "live-secret", stored_session_id: "stored/1" }
      throw new Error("unexpected native request")
    })
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored%2F1?"))
        return {
          id: "stored/1",
          profile: "researcher",
          title: "One",
          last_active: 1,
        }
      throw new Error(`unexpected native path: ${path}`)
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({ request: nativeRequest, http }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const created = await app.request(
      request("/api/aos/v1/agents/researcher/sessions", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ title: "One" }),
      })
    )
    expect(created.status).toBe(201)
    const createdPayload = await created.json()
    expect(createdPayload).toEqual({
      session: {
        id: "hermes:researcher:stored%2F1",
        agentId: "researcher",
      },
    })

    const detail = await app.request(
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored%252F1"
      )
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual({
      id: "hermes:researcher:stored%2F1",
      agentId: "researcher",
      title: "One",
      archived: false,
      updatedAt: "1970-01-01T00:00:01.000Z",
      status: "unknown",
    })

    for (const body of [
      { title: "Renamed" },
      { archived: true },
      { archived: false },
    ]) {
      expect(
        (
          await app.request(
            request(
              "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored%252F1",
              {
                method: "PATCH",
                headers: { origin, "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            )
          )
        ).status
      ).toBe(204)
    }
    expect(
      (
        await app.request(
          request(
            "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored%252F1",
            { method: "DELETE", headers: { origin } }
          )
        )
      ).status
    ).toBe(204)
    expect(JSON.stringify(createdPayload)).not.toContain("live-secret")
    expect(
      http.mock.calls
        .filter(([, init]) => init?.method === "PATCH")
        .map(([, init]) => init?.body)
    ).toEqual([{ title: "Renamed" }, { archived: true }, { archived: false }])
  })

  it("strictly validates Session queries and mutation bodies before native dispatch", async () => {
    const nativeRequest = vi.fn(async () => ({ profiles: [nativeProfile()] }))
    const http = vi.fn(async () => ({ sessions: [], total: 0 }))
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({ request: nativeRequest, http }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(
      (
        await app.request(
          request("/api/aos/v1/agents/researcher/sessions?limit=50&limit=10")
        )
      ).status
    ).toBe(400)
    expect(
      (await app.request(request("/api/aos/v1/sessions?limit=100&offset=901")))
        .status
    ).toBe(400)
    expect(
      (
        await app.request(
          request("/api/aos/v1/agents/researcher/sessions?native=true")
        )
      ).status
    ).toBe(400)
    expect(
      (
        await app.request(
          request("/api/aos/v1/agents/researcher/sessions", {
            method: "POST",
            headers: { origin },
            body: "{}",
          })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await app.request(
          request("/api/aos/v1/agents/researcher/sessions", {
            method: "POST",
            headers: {
              origin,
              "content-type": "application/json",
              "content-length": String(16 * 1024 + 1),
            },
            body: "{}",
          })
        )
      ).status
    ).toBe(400)
    expect(http).not.toHaveBeenCalled()
    expect(nativeRequest).not.toHaveBeenCalled()
  })

  it("maps owned Session absence, conflicts, and outages to precise public statuses", async () => {
    const responseFor = async (status: number) => {
      const http = vi
        .fn()
        .mockResolvedValueOnce({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })
        .mockRejectedValueOnce(new HermesHttpError(status))
      const app = createProxyApp({
        publicOrigin: origin,
        operatorAuth: createOperatorAuthenticator({
          allowedSubjects: ["operator@example.test"],
          verifySession: vi.fn(async () => ({
            subject: "operator@example.test",
          })),
        }),
        hermes: new HermesServerAdapter({ request: vi.fn(), http }),
        logger: { info: vi.fn(), error: vi.fn() },
      })
      return app.request(
        request(
          "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored",
          {
            method: "PATCH",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ archived: true }),
          }
        )
      )
    }

    expect((await responseFor(404)).status).toBe(404)
    expect((await responseFor(409)).status).toBe(409)
    expect((await responseFor(500)).status).toBe(503)
  })

  it("bounds Session catalog/history reads and rejects cross-Agent identities before native dispatch", async () => {
    const http = vi.fn(async () => ({ sessions: [], total: 0 }))
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({ request: vi.fn(), http }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    expect(
      (await app.request(request("/api/aos/v1/agents/researcher/sessions")))
        .status
    ).toBe(200)
    expect(
      (
        await app.request(
          request("/api/aos/v1/agents/researcher/sessions?limit=101")
        )
      ).status
    ).toBe(400)
    expect(
      (
        await app.request(
          request(
            "/api/aos/v1/agents/researcher/sessions/hermes:other:stored/history"
          )
        )
      ).status
    ).toBe(404)
    expect(http).toHaveBeenCalledTimes(1)
  })
  it("exposes one bounded global recent Session page", async () => {
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: vi.fn(async () => ({ profiles: [nativeProfile()] })),
        http: vi.fn(async () => ({
          sessions: [
            {
              id: "stored",
              profile: "researcher",
              title: "Recent",
              last_active: 2,
            },
          ],
          total: 1,
        })),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const response = await app.request(request("/api/aos/v1/sessions"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      sessions: [{ id: "hermes:researcher:stored" }],
      total: 1,
      limit: 50,
      offset: 0,
    })
  })
  it("requires an allowlisted OIDC operator on every runtime control-plane read", async () => {
    const operatorAuth = createOperatorAuthenticator({
      allowedSubjects: ["operator@example.test"],
      verifySession: vi.fn(async (candidate: Request) =>
        candidate.headers.get("cookie")?.includes("valid")
          ? { subject: "intruder@example.test", displayName: "Intruder" }
          : undefined
      ),
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      hermes: new HermesServerAdapter({ request: vi.fn() }),
      logger: { info: vi.fn(), error: vi.fn() },
      clock: () => 1_000,
    })

    const auth = await app.request(request("/api/aos/v1/auth/operator"))
    expect(auth.status).toBe(200)
    expect(await auth.json()).toEqual({ status: "unauthenticated" })
    const runtime = await app.request(request("/api/aos/v1/runtime"))
    expect(runtime.status).toBe(401)
    expect(await runtime.json()).toEqual({
      error: { code: "unauthenticated" },
    })
  })

  it("walks operator auth through Hermes auth, runtime, Agents, and CAS visibility", async () => {
    const verifySession = vi.fn(async () => ({
      subject: "operator@example.test",
      displayName: "Operator",
    }))
    const operatorAuth = createOperatorAuthenticator({
      allowedSubjects: ["operator@example.test"],
      verifySession,
    })
    let hidden = false
    let revision = 7
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === "profiles.list")
        return { profiles: [nativeProfile(hidden, revision)] }
      if (method === "profiles.describe") return nativeProfile(hidden, revision)
      if (method === "profiles.configure") {
        hidden = true
        revision = 8
        return { applied: { ui_meta: true } }
      }
      throw new Error("unexpected native request")
    })
    const logger = { info: vi.fn(), error: vi.fn() }
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      hermes: new HermesServerAdapter({ request: nativeRequest }),
      logger,
      clock: () => 1_000,
    })

    const operator = await app.request(request("/api/aos/v1/auth/operator"))
    expect(await operator.json()).toEqual({
      status: "authenticated",
      operator: { id: "operator@example.test", displayName: "Operator" },
    })

    const hermesAuth = await app.request(request("/api/aos/v1/auth/hermes"))
    expect(await hermesAuth.json()).toEqual({
      status: "authenticated",
      method: "static-token",
    })

    const runtime = await app.request(request("/api/aos/v1/runtime"))
    expect(await runtime.json()).toMatchObject({
      runtime: { id: "hermes", name: "Hermes" },
      status: "ready",
      capabilities: {
        agentCatalog: { status: "available" },
        agentVisibility: { status: "available", concurrency: "revision" },
      },
    })

    const catalog = await app.request(request("/api/aos/v1/agents"))
    expect(await catalog.json()).toMatchObject({
      revision: "profiles:researcher@hermes-bots:7",
      agents: [{ summary: { id: "researcher" }, revision: "hermes-bots:7" }],
    })

    const updated = await app.request(
      request("/api/aos/v1/agents/researcher/visibility", {
        method: "PATCH",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          visibility: "hidden",
          revision: "hermes-bots:7",
        }),
      })
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      agent: {
        summary: { id: "researcher" },
        visibility: "hidden",
        revision: "hermes-bots:8",
      },
    })
    expect(verifySession).toHaveBeenCalled()
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("researcher")
  })

  it("rejects stale visibility writes and cross-origin mutation requests", async () => {
    const operatorAuth = createOperatorAuthenticator({
      allowedSubjects: ["operator@example.test"],
      verifySession: vi.fn(async () => ({ subject: "operator@example.test" })),
    })
    const nativeRequest = vi.fn(async () => ({ profiles: [nativeProfile()] }))
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      hermes: new HermesServerAdapter({ request: nativeRequest }),
      logger: { info: vi.fn(), error: vi.fn() },
      clock: () => 1_000,
    })

    const crossOrigin = await app.request(
      request("/api/aos/v1/agents/researcher/visibility", {
        method: "PATCH",
        headers: {
          origin: "https://attacker.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          visibility: "hidden",
          revision: "hermes-bots:7",
        }),
      })
    )
    expect(crossOrigin.status).toBe(403)
    expect(nativeRequest).not.toHaveBeenCalled()

    const stale = await app.request(
      request("/api/aos/v1/agents/researcher/visibility", {
        method: "PATCH",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          visibility: "hidden",
          revision: "hermes-bots:6",
        }),
      })
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({
      error: { code: "revision_conflict" },
    })
  })

  it("maps a missing Agent to 404 without confusing it with an outage", async () => {
    const operatorAuth = createOperatorAuthenticator({
      allowedSubjects: ["operator@example.test"],
      verifySession: vi.fn(async () => ({ subject: "operator@example.test" })),
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      hermes: new HermesServerAdapter({
        request: vi.fn(async () => ({ profiles: [nativeProfile()] })),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const response = await app.request(
      request("/api/aos/v1/agents/missing-agent/visibility", {
        method: "PATCH",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          visibility: "hidden",
          revision: "hermes-bots:7",
        }),
      })
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: "not_found" } })
  })

  it("keeps liveness independent and readiness tied to the Hermes adapter", async () => {
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => undefined),
      }),
      hermes: new HermesServerAdapter({
        request: vi.fn(async () => {
          throw new Error("native path /private and token=secret")
        }),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
      clock: () => 1_000,
    })
    expect((await app.request("/api/aos/v1/healthz")).status).toBe(200)
    const readiness = await app.request("/api/aos/v1/readyz")
    expect(readiness.status).toBe(503)
    expect(await readiness.json()).toEqual({
      status: "not-ready",
      timestamp: 1_000,
      runtime: "unavailable",
    })
  })
})
