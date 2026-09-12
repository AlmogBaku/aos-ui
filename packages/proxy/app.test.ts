import { describe, expect, it, vi } from "vitest"

import { createProxyApp } from "./app"
import { HermesServerAdapter } from "./hermes-adapter"
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
