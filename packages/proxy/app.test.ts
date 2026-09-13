import { describe, expect, it, vi } from "vitest"

import { createProxyApp } from "./app"
import { OidcAuthenticationError } from "./auth/oidc"
import { HermesServerAdapter } from "./runtimes/hermes/adapter"
import { HermesBrowserAuthenticationError } from "./runtimes/hermes/auth-broker"
import {
  HermesAuthenticationError,
  HermesHttpError,
  HermesWebSocketRpcTransport,
} from "./runtimes/hermes/transport"
import { createOperatorAuthenticator } from "./operator-auth"
import {
  HermesRunPublicError,
  type HermesRunEngine,
} from "./runtimes/hermes/run"

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
  it("delegates opaque public Session identity resolution to the server runtime", async () => {
    const resolveSessionId = vi.fn((agentId: string, sessionId: string) =>
      agentId === "researcher" && sessionId === "opaque-session"
        ? "stored"
        : undefined
    )
    const hermes = Object.assign(
      new HermesServerAdapter({
        request: vi.fn(),
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
      }),
      { resolveSessionId }
    )
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const response = await app.request(
      request("/api/aos/v1/agents/researcher/sessions/opaque-session")
    )

    expect(response.status).toBe(200)
    expect(resolveSessionId).toHaveBeenCalledWith(
      "researcher",
      "opaque-session"
    )
  })

  it("allows only an authenticated operator to create a scoped guest invitation", async () => {
    const issue = vi.fn(async (grant) => ({ token: "guest.jwt", grant }))
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async (request) =>
          request.headers.get("cookie") === "aos_operator=valid"
            ? { subject: "operator@example.test" }
            : undefined
        ),
      }),
      guestInvitations: { issue, verify: vi.fn() },
      hermes: new HermesServerAdapter({ request: vi.fn() }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const invitation = {
      principalId: "guest_recipient",
      invitationId: "invite_public",
      agentId: "researcher",
      sessionId: "hermes:researcher:stored",
      operations: ["messages:create", "messages:read"],
      capabilities: ["message-text"],
    }
    const create = (cookie?: string) =>
      app.request(
        new Request("http://proxy.test/api/aos/v1/guest-invitations", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(invitation),
        })
      )

    expect((await create()).status).toBe(401)
    const response = await create("aos_operator=valid")
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      token: "guest.jwt",
      grant: invitation,
    })
    expect(issue).toHaveBeenCalledWith(invitation)
  })

  it("serves the normalized owned Hermes workspace, content, and audio routes", async () => {
    const hermes = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(hermes, "getSession").mockResolvedValue({
      id: "hermes:researcher:stored",
      agentId: "researcher",
      title: "Owned",
      archived: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "idle",
    })
    vi.spyOn(hermes, "models").mockResolvedValue({
      selectedId: '["native","small"]',
      options: [{ id: '["native","small"]', label: "small", group: "Native" }],
    })
    vi.spyOn(hermes, "todos").mockResolvedValue([
      { id: "todo-1", label: "Inspect", status: "active" },
    ])
    vi.spyOn(hermes, "audio").mockResolvedValue({
      transcription: { status: "ready" },
      speech: { status: "unavailable", reason: "not-configured" },
    })
    vi.spyOn(hermes, "speak").mockResolvedValue({
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: "audio/mpeg",
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const base =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored"

    expect(
      await (await app.request(request(`${base}/workspace/models`))).json()
    ).toEqual({
      selectedId: '["native","small"]',
      options: [{ id: '["native","small"]', label: "small", group: "Native" }],
    })
    expect(
      await (await app.request(request(`${base}/workspace/todos`))).json()
    ).toEqual({
      todos: [{ id: "todo-1", label: "Inspect", status: "active" }],
    })
    expect(await (await app.request(request(`${base}/audio`))).json()).toEqual({
      transcription: { status: "ready" },
      speech: { status: "unavailable", reason: "not-configured" },
    })
    const speech = await app.request(
      request(`${base}/audio/speak`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      })
    )
    expect(speech.status).toBe(200)
    expect(speech.headers.get("content-type")).toBe("audio/mpeg")
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3)
    )

    const crossScope = await app.request(
      request(
        "/api/aos/v1/agents/other/sessions/hermes%3Aresearcher%3Astored/workspace/models"
      )
    )
    expect(crossScope.status).toBe(404)
  })

  it("binds one opaque attachment stage to the next same-Session AG-UI run", async () => {
    const cleanup = vi.fn(async () => undefined)
    const hermes = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(hermes, "getSession").mockResolvedValue({
      id: "hermes:researcher:stored",
      agentId: "researcher",
      title: "Owned",
      archived: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "idle",
    })
    vi.spyOn(hermes, "stageAttachments").mockResolvedValue({
      public: [{ type: "file", filename: "notes.txt", mimeType: "text/plain" }],
      appendTo: (text: string) => `${text}\n@file:private-reference`,
      cleanup,
    })
    const start = vi.fn(async () => ({
      events: (async function* () {
        yield {
          type: "RUN_FINISHED" as const,
          threadId: "hermes:researcher:stored",
          runId: "run-1",
          outcome: { type: "success" as const },
        }
      })(),
      stop: async () => "idle" as const,
      disconnect: vi.fn(),
      recoveryPosition: () => ({ epoch: "epoch", lastSeen: 0 }),
    }))
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes,
      runEngine: { start } as unknown as HermesRunEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const base =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored"
    const staged = await app.request(
      request(`${base}/attachments/stage`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          attachments: [
            {
              type: "file",
              dataUrl: "data:text/plain;base64,YQ==",
              filename: "notes.txt",
              mimeType: "text/plain",
            },
          ],
        }),
      })
    )
    expect(staged.status).toBe(201)
    const stage = (await staged.json()) as { stageId: string }
    expect(stage).toMatchObject({
      stageId: expect.any(String),
      attachments: [
        { type: "file", filename: "notes.txt", mimeType: "text/plain" },
      ],
    })
    expect(JSON.stringify(stage)).not.toContain("private-reference")

    const run = await app.request(
      request(`${base}/runs`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "hermes:researcher:stored",
          runId: "run-1",
          state: {},
          messages: [{ id: "user-1", role: "user", content: "Inspect" }],
          tools: [],
          context: [],
          forwardedProps: { aosAttachmentStageId: stage.stageId },
        }),
      })
    )
    expect(run.status).toBe(200)
    expect(start).toHaveBeenCalledWith(
      {
        agentId: "researcher",
        sessionId: "stored",
        threadId: "hermes:researcher:stored",
      },
      expect.objectContaining({
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Inspect\n@file:private-reference",
          },
        ],
        forwardedProps: {},
      })
    )
    expect(cleanup).not.toHaveBeenCalled()

    const replay = await app.request(
      request(`${base}/runs`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "hermes:researcher:stored",
          runId: "run-2",
          state: {},
          messages: [{ id: "user-2", role: "user", content: "Again" }],
          tools: [],
          context: [],
          forwardedProps: { aosAttachmentStageId: stage.stageId },
        }),
      })
    )
    expect(replay.status).toBe(400)
  })

  it("responds to a restored interaction through the normalized JSON route", async () => {
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "live-private",
          running: true,
          pending_approval: {
            request_id: "approval-1",
            description: "Deploy?",
            choices: ["deny", "once"],
          },
        }
      if (method === "approval.respond") return { status: "ok" }
      throw new Error(`Unexpected native RPC: ${method}`)
    })
    const hermes = new HermesServerAdapter({ request: nativeRequest })
    vi.spyOn(hermes, "getSession").mockResolvedValue({
      id: "hermes:researcher:stored",
      agentId: "researcher",
      title: "Owned",
      archived: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "waiting-for-input",
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const route =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/interactions/respond"
    const invalid = await app.request(
      request(route, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-1", requestId: "approval-1" }),
      })
    )
    expect(invalid.status).toBe(400)
    expect(nativeRequest).not.toHaveBeenCalled()

    const response = await app.request(
      request(route, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-1",
          requestId: "approval-1",
          response: { kind: "question", answers: [["once"]] },
        }),
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({ status: "resolved" })
    expect(nativeRequest).toHaveBeenLastCalledWith("approval.respond", {
      session_id: "live-private",
      request_id: "approval-1",
      choice: "once",
    })
  })

  it("restores authoritative pending interactions without a client-held run ID", async () => {
    const hermes = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(hermes, "getSession").mockResolvedValue({
      id: "hermes:researcher:stored",
      agentId: "researcher",
      title: "Owned",
      archived: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "waiting-for-input",
    })
    vi.spyOn(hermes, "pendingInteractions").mockResolvedValue({
      runId: "aos-hermes-restored-interaction",
      running: true,
      status: "waiting-for-input",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "approval-1",
            reason: "approval",
            message: "Allow this action?",
            responseSchema: { type: "string", enum: ["once", "deny"] },
          },
        ],
      },
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const base =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored"

    const response = await app.request(request(`${base}/interactions/pending`))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      runId: "aos-hermes-restored-interaction",
      running: true,
      status: "waiting-for-input",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "approval-1", reason: "approval" }],
      },
    })
    expect(JSON.stringify(body)).not.toContain("live-secret")
    expect(hermes.pendingInteractions).toHaveBeenCalledWith(
      "researcher",
      "hermes:researcher:stored",
      undefined
    )

    expect(
      (
        await app.request(
          request(`${base}/interactions/pending?runId=one&runId=two`)
        )
      ).status
    ).toBe(400)
  })

  it("uses provider-neutral OIDC and runtime authentication routes", async () => {
    const operatorOidc = {
      begin: vi.fn(async () => ({
        authorizationUrl: new URL("https://identity.example.test/authorize"),
        flowCookie:
          "__Host-aos-oidc-flow=opaque; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax",
      })),
      complete: vi.fn(async () => ({
        status: "authenticated" as const,
        returnPath: "/researcher/session",
        session: {
          principalId: "aos_principal_opaque",
          sessionId: "browser-session",
          issuedAt: 1,
          expiresAt: 901,
        },
        sessionCookie:
          "__Host-aos-session=sealed; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax",
        flowCookie:
          "__Host-aos-oidc-flow=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
      })),
    }
    const runtimeAuth = {
      state: vi.fn(async () => ({ status: "authenticated" as const })),
    }
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      operatorOidc,
      runtimeAuth,
      hermes: new HermesServerAdapter({ request: vi.fn() }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const start = await app.request(
      request("/api/aos/v1/auth/operator/start?return=%2Fresearcher%2Fsession")
    )
    expect(start.status).toBe(302)
    expect(start.headers.get("location")).toBe(
      "https://identity.example.test/authorize"
    )
    expect(start.headers.get("set-cookie")).toContain(
      "__Host-aos-oidc-flow=opaque"
    )
    expect(operatorOidc.begin).toHaveBeenCalledWith("/researcher/session")

    const callback = await app.request(
      request(
        "/api/aos/v1/auth/operator/callback?code=provider-code&state=provider-state"
      )
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/researcher/session")
    expect(
      (
        callback.headers as Headers & { getSetCookie(): string[] }
      ).getSetCookie()
    ).toEqual([
      expect.stringContaining("__Host-aos-oidc-flow=;"),
      expect.stringContaining("__Host-aos-session=sealed;"),
    ])

    const normalized = await app.request(request("/api/aos/v1/auth/runtime"))
    expect(await normalized.json()).toEqual({ status: "authenticated" })
    expect((await app.request(request("/api/aos/v1/auth/hermes"))).status).toBe(
      404
    )
  })

  it("binds runtime browser login to the verified principal and browser session", async () => {
    const begin = vi.fn(async () => ({
      status: "redirect" as const,
      response: new Response(null, {
        status: 302,
        headers: { location: "https://identity.example.test/runtime" },
      }),
    }))
    const complete = vi.fn(async () => ({
      status: "authenticated" as const,
      returnPath: "/researcher/session",
    }))
    const operatorAuth = {
      state: vi.fn(async () => ({
        status: "authenticated" as const,
        operator: { id: "aos_principal_opaque" },
      })),
      require: vi.fn(async () => ({
        status: "authenticated" as const,
        operator: { id: "aos_principal_opaque" },
      })),
      session: vi.fn(async () => ({
        principalId: "aos_principal_opaque",
        sessionId: "browser-session",
        issuedAt: 1,
        expiresAt: 901,
      })),
    }
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      runtimeAuth: {
        state: vi.fn(async () => ({ status: "authentication-required" })),
        begin,
        complete,
      },
      hermes: new HermesServerAdapter({ request: vi.fn() }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const start = await app.request(
      request("/api/aos/v1/auth/runtime/start?return=%2Fresearcher%2Fsession")
    )
    expect(start.status).toBe(302)
    expect(begin).toHaveBeenCalledWith({
      principalId: "aos_principal_opaque",
      lane: "operator",
      browserSessionId: "browser-session",
      callbackUrl: `${origin}/api/aos/v1/auth/runtime/upstream/auth/callback`,
      returnPath: "/researcher/session",
    })

    const callback = await app.request(
      request(
        "/api/aos/v1/auth/runtime/upstream/auth/callback?code=code&state=state"
      )
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/researcher/session")
    expect(complete).toHaveBeenCalledWith({
      principalId: "aos_principal_opaque",
      lane: "operator",
      browserSessionId: "browser-session",
      callbackUrl: `${origin}/api/aos/v1/auth/runtime/upstream/auth/callback?code=code&state=state`,
      returnPath: "/",
    })
  })

  it("maps typed auth failures without logging callback codes or state", async () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    const operatorAuth = {
      state: vi.fn(async () => ({
        status: "authenticated" as const,
        operator: { id: "principal" },
      })),
      require: vi.fn(async () => ({
        status: "authenticated" as const,
        operator: { id: "principal" },
      })),
      session: vi.fn(async () => ({
        principalId: "principal",
        sessionId: "browser-session",
        issuedAt: 1,
        expiresAt: 901,
      })),
    }
    const operatorOidc = {
      begin: vi.fn(async () => {
        throw new OidcAuthenticationError("temporarily-unavailable")
      }),
      complete: vi.fn(),
    }
    const complete = vi.fn(async () => {
      throw new HermesBrowserAuthenticationError("invalid-flow")
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      operatorOidc,
      runtimeAuth: {
        state: vi.fn(() => ({ status: "authentication-required" })),
        complete,
      },
      hermes: new HermesServerAdapter({ request: vi.fn() }),
      logger,
    })

    const unavailable = await app.request(
      request("/api/aos/v1/auth/operator/start?return=%2F")
    )
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({
      error: { code: "temporarily_unavailable" },
    })

    const callback = await app.request(
      request(
        "/api/aos/v1/auth/runtime/upstream/auth/callback?code=provider-secret&state=state-secret"
      )
    )
    expect(callback.status).toBe(401)
    expect(await callback.json()).toEqual({
      error: { code: "runtime_authentication_required" },
    })
    const logs = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.error.mock.calls,
    ])
    expect(logs).not.toContain("provider-secret")
    expect(logs).not.toContain("state-secret")
  })

  it("requires normalized runtime auth and selects a principal-bound adapter", async () => {
    const operatorAuth = createOperatorAuthenticator({
      allowedSubjects: ["operator@example.test"],
      verifySession: vi.fn(async () => ({ subject: "operator@example.test" })),
    })
    const hermesForOperator = vi.fn(
      () =>
        new HermesServerAdapter({
          request: vi.fn(async () => ({ profiles: [] })),
        })
    )
    const blocked = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      runtimeAuth: {
        state: vi.fn(() => ({ status: "authentication-required" })),
      },
      hermesForOperator,
      hermes: new HermesServerAdapter({ request: vi.fn() }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const denied = await blocked.request(request("/api/aos/v1/agents"))
    expect(denied.status).toBe(401)
    expect(await denied.json()).toEqual({
      error: { code: "runtime_authentication_required" },
    })
    expect(hermesForOperator).not.toHaveBeenCalled()

    const allowed = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      runtimeAuth: { state: vi.fn(() => ({ status: "authenticated" })) },
      hermesForOperator,
      hermes: new HermesServerAdapter({ request: vi.fn() }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    expect((await allowed.request(request("/api/aos/v1/agents"))).status).toBe(
      200
    )
    expect(hermesForOperator).toHaveBeenCalledWith("operator@example.test")

    const expired = createProxyApp({
      publicOrigin: origin,
      operatorAuth,
      runtimeAuth: { state: vi.fn(() => ({ status: "authenticated" })) },
      hermesForOperator: () =>
        new HermesServerAdapter({
          request: vi.fn(async () => {
            throw new HermesAuthenticationError()
          }),
        }),
      hermes: new HermesServerAdapter({ request: vi.fn() }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const rejected = await expired.request(request("/api/aos/v1/agents"))
    expect(rejected.status).toBe(401)
    expect(await rejected.json()).toEqual({
      error: { code: "runtime_authentication_required" },
    })
  })

  it("streams an owned Session run and rejects cross-Agent scope before run I/O", async () => {
    const start = vi.fn(async () => ({
      events: (async function* () {
        yield {
          type: "RUN_STARTED" as const,
          threadId: "hermes:researcher:stored",
          runId: "run-1",
        }
        yield {
          type: "RUN_FINISHED" as const,
          threadId: "hermes:researcher:stored",
          runId: "run-1",
          outcome: { type: "success" as const },
        }
      })(),
      stop: async () => "idle" as const,
      disconnect: vi.fn(),
      recoveryPosition: () => ({ epoch: "epoch-1", lastSeen: 2 }),
    }))
    const runEngine = { start } as unknown as HermesRunEngine
    const http = vi.fn(async () => ({
      id: "stored",
      profile: "researcher",
      title: "Owned",
    }))
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({ request: vi.fn(), http }),
      runEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const body = JSON.stringify({
      threadId: "hermes:researcher:stored",
      runId: "run-1",
      state: {},
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    const crossScope = await app.request(
      request(
        "/api/aos/v1/agents/other/sessions/hermes%3Aresearcher%3Astored/runs",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body,
        }
      )
    )
    expect(crossScope.status).toBe(404)
    expect(start).not.toHaveBeenCalled()
    expect(http).not.toHaveBeenCalled()

    const response = await app.request(
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body,
        }
      )
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(await response.text()).toBe(
      'data: {"type":"RUN_STARTED","threadId":"hermes:researcher:stored","runId":"run-1"}\n\ndata: {"type":"RUN_FINISHED","threadId":"hermes:researcher:stored","runId":"run-1","outcome":{"type":"success"}}\n\n'
    )
    expect(start).toHaveBeenCalledWith(
      {
        agentId: "researcher",
        sessionId: "stored",
        threadId: "hermes:researcher:stored",
      },
      JSON.parse(body)
    )
  })

  it("wires the Hermes native boundary to public AG-UI reasoning and tool SSE", async () => {
    let publish: ((event: unknown) => void) | undefined
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === "session.resume") return { session_id: "live-secret" }
      if (method === "session.events.since")
        return { epoch: "epoch-secret", last_seen: 0, events: [] }
      if (method === "session.active_list") return { sessions: [] }
      if (method === "prompt.submit") {
        for (const [seq, type, payload] of [
          [1, "message.start", { message_id: "assistant-1" }],
          [2, "reasoning.delta", { text: "Inspecting" }],
          [
            3,
            "tool.start",
            {
              tool_id: "terminal-1",
              name: "terminal",
              args: { command: "pwd", path: "/srv/hermes/private" },
            },
          ],
          [
            4,
            "tool.complete",
            {
              tool_id: "terminal-1",
              name: "terminal",
              result: { status: "ok", path: "/srv/hermes/private" },
            },
          ],
          [5, "message.delta", { text: "Done" }],
          [6, "message.complete", {}],
        ] as const)
          publish?.({ type, session_id: "live-secret", seq, payload })
        return { accepted: true }
      }
      throw new Error(`unexpected ${method}`)
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: nativeRequest,
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
        observeEvents: vi.fn(async (listener) => {
          publish = listener
          return () => undefined
        }),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const response = await app.request(
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "hermes:researcher:stored",
            runId: "run-1",
            state: {},
            messages: [{ id: "user-1", role: "user", content: "Hello" }],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        }
      )
    )

    expect(response.status).toBe(200)
    const stream = await response.text()
    expect(stream).toContain('"type":"REASONING_MESSAGE_CONTENT"')
    expect(stream).toContain('"type":"TOOL_CALL_START"')
    expect(stream).toContain('"toolCallName":"terminal"')
    expect(stream).toContain('"delta":"{}"')
    expect(stream).toContain('"type":"RUN_FINISHED"')
    for (const leak of [
      "live-secret",
      "epoch-secret",
      "session_id",
      "/srv/hermes",
      '"payload"',
      '"seq"',
    ])
      expect(stream).not.toContain(leak)
  })

  it("detaches a closed stream without stopping and interrupts only on Stop POST", async () => {
    let finishObservation: (() => void) | undefined
    const observationFinished = new Promise<void>((resolve) => {
      finishObservation = resolve
    })
    const disconnect = vi.fn(() => finishObservation?.())
    const stop = vi.fn(async () => "stopping" as const)
    const runEngine = {
      start: vi.fn(async () => ({
        events: (async function* () {
          yield {
            type: "RUN_STARTED" as const,
            threadId: "hermes:researcher:stored",
            runId: "run-1",
          }
          await observationFinished
        })(),
        stop,
        disconnect,
        recoveryPosition: () => ({ epoch: "epoch-1", lastSeen: 0 }),
      })),
    } as unknown as HermesRunEngine
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: vi.fn(),
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
      }),
      runEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const response = await app.request(
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "hermes:researcher:stored",
            runId: "run-1",
            state: {},
            messages: [{ id: "user-1", role: "user", content: "Hello" }],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        }
      )
    )

    await response.body?.cancel()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()

    const stopped = await app.request(
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/stop",
        { method: "POST", headers: { origin } }
      )
    )
    expect(stopped.status).toBe(202)
    expect(await stopped.json()).toEqual({ status: "stopping" })
    expect(stop).toHaveBeenCalledTimes(1)

    const stillStopping = await app.request(
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/stop",
        { method: "POST", headers: { origin } }
      )
    )
    expect(stillStopping.status).toBe(202)
    expect(await stillStopping.json()).toEqual({ status: "stopping" })
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it("reconnects only the owning operator's exact active run and evicts it after a terminal event", async () => {
    let releaseFirst: (() => void) | undefined
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = {
      events: (async function* () {
        yield {
          type: "RUN_STARTED" as const,
          threadId: "hermes:researcher:stored",
          runId: "run-1",
        }
        await firstReleased
      })(),
      stop: vi.fn(async () => "stopping" as const),
      disconnect: vi.fn(() => releaseFirst?.()),
      recoveryPosition: vi.fn(() => ({
        epoch: "server-held-epoch",
        lastSeen: 7,
      })),
    }
    const terminalHandle = (runId: string) => ({
      events: (async function* () {
        yield {
          type: "RUN_STARTED" as const,
          threadId: "hermes:researcher:stored",
          runId,
        }
        yield {
          type: "RUN_FINISHED" as const,
          threadId: "hermes:researcher:stored",
          runId,
          outcome: { type: "success" as const },
        }
      })(),
      stop: vi.fn(async () => "idle" as const),
      disconnect: vi.fn(),
      recoveryPosition: vi.fn(() => ({ epoch: "next", lastSeen: 8 })),
    })
    const recovered = terminalHandle("run-1")
    const start = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(terminalHandle("run-2"))
    const reconnect = vi.fn(async () => recovered)
    const runEngine = { start, reconnect } as unknown as HermesRunEngine
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["one@example.test", "two@example.test"],
        verifySession: vi.fn(async (incoming) => ({
          subject:
            incoming.headers.get("cookie") === "aos_operator=two"
              ? "two@example.test"
              : "one@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: vi.fn(),
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
      }),
      runEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const base =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs"
    const runBody = (runId: string) =>
      JSON.stringify({
        threadId: "hermes:researcher:stored",
        runId,
        state: {},
        messages: [{ id: `user-${runId}`, role: "user", content: "Hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      })
    const opened = await app.request(
      request(base, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: runBody("run-1"),
      })
    )
    await opened.body?.cancel()

    const foreign = await app.request(
      request(`${base}/reconnect`, {
        method: "POST",
        headers: {
          origin,
          cookie: "aos_operator=two",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          threadId: "hermes:researcher:stored",
          runId: "run-1",
        }),
      })
    )
    expect(foreign.status).toBe(404)
    expect(reconnect).not.toHaveBeenCalled()

    const response = await app.request(
      request(`${base}/reconnect`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "hermes:researcher:stored",
          runId: "run-1",
        }),
      })
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"RUN_FINISHED"')
    expect(first.recoveryPosition).toHaveBeenCalledOnce()
    expect(reconnect).toHaveBeenCalledWith(
      {
        agentId: "researcher",
        sessionId: "stored",
        threadId: "hermes:researcher:stored",
      },
      {
        threadId: "hermes:researcher:stored",
        runId: "run-1",
        position: { epoch: "server-held-epoch", lastSeen: 7 },
      }
    )

    const next = await app.request(
      request(base, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: runBody("run-2"),
      })
    )
    expect(next.status).toBe(200)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it("reattaches an authoritative native run after the proxy active-run map is empty", async () => {
    const recovered = {
      events: (async function* () {
        yield {
          type: "RUN_STARTED" as const,
          threadId: "hermes:researcher:stored",
          runId: "restored-run",
        }
        yield {
          type: "RUN_FINISHED" as const,
          threadId: "hermes:researcher:stored",
          runId: "restored-run",
          outcome: { type: "success" as const },
        }
      })(),
      stop: vi.fn(async () => "idle" as const),
      disconnect: vi.fn(),
      recoveryPosition: vi.fn(() => ({ epoch: "native", lastSeen: 8 })),
    }
    const reconnect = vi.fn(async () => recovered)
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: vi.fn(),
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
      }),
      runEngine: { start: vi.fn(), reconnect } as unknown as HermesRunEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const response = await app.request(
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/reconnect",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "hermes:researcher:stored",
            runId: "restored-run",
          }),
        }
      )
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"RUN_FINISHED"')
    expect(reconnect).toHaveBeenCalledWith(
      {
        agentId: "researcher",
        sessionId: "stored",
        threadId: "hermes:researcher:stored",
      },
      {
        threadId: "hermes:researcher:stored",
        runId: "restored-run",
      }
    )
  })

  it("pulls at most one AG-UI event ahead of a slow SSE consumer", async () => {
    let index = 0
    const next = vi.fn(async () => {
      index += 1
      return index <= 20
        ? {
            done: false as const,
            value: {
              type: "RUN_STARTED" as const,
              threadId: "hermes:researcher:stored",
              runId: `run-${index}`,
            },
          }
        : { done: true as const, value: undefined }
    })
    const closeIterator = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }))
    const disconnect = vi.fn()
    const runEngine = {
      start: vi.fn(async () => ({
        events: {
          [Symbol.asyncIterator]: () => ({ next, return: closeIterator }),
        },
        stop: vi.fn(async () => "stopping" as const),
        disconnect,
        recoveryPosition: () => ({ epoch: "opaque", lastSeen: 0 }),
      })),
    } as unknown as HermesRunEngine
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: vi.fn(),
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
      }),
      runEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const response = await app.request(
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "hermes:researcher:stored",
            runId: "run-1",
            state: {},
            messages: [{ id: "user-1", role: "user", content: "Hello" }],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        }
      )
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(next.mock.calls.length).toBeLessThanOrEqual(1)
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(next.mock.calls.length).toBeLessThanOrEqual(2)
    await reader.cancel()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(closeIterator).toHaveBeenCalledTimes(1)
  })

  it("routes deliberate Stop through native interrupt and remains stopping", async () => {
    let statusReads = 0
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === "session.resume") return { session_id: "live-secret" }
      if (method === "session.events.since")
        return { epoch: "epoch-secret", last_seen: 0, events: [] }
      if (method === "session.active_list") {
        statusReads += 1
        return statusReads === 1
          ? { sessions: [] }
          : { sessions: [{ id: "live-secret", status: "working" }] }
      }
      if (method === "prompt.submit" || method === "session.interrupt")
        return { accepted: true }
      throw new Error(`unexpected ${method}`)
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: nativeRequest,
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
        observeEvents: vi.fn(async () => () => undefined),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const route =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs"
    const response = await app.request(
      request(route, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "hermes:researcher:stored",
          runId: "run-1",
          state: {},
          messages: [{ id: "user-1", role: "user", content: "Hello" }],
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      })
    )
    expect(response.status).toBe(200)

    const stopped = await app.request(
      request(`${route}/stop`, { method: "POST", headers: { origin } })
    )
    expect(stopped.status).toBe(202)
    expect(await stopped.json()).toEqual({ status: "stopping" })
    expect(nativeRequest.mock.calls).toContainEqual([
      "session.interrupt",
      { session_id: "live-secret" },
    ])
    await response.body?.cancel()
  })

  it("bounds and strictly validates run requests before native run I/O", async () => {
    const nativeRequest = vi.fn()
    const nativeHttp = vi.fn(async () => ({
      id: "stored",
      profile: "researcher",
      title: "Owned",
    }))
    const start = vi.fn()
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: nativeRequest,
        http: nativeHttp,
      }),
      runEngine: { start } as unknown as HermesRunEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const path =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs"
    const validBody = JSON.stringify({
      threadId: "hermes:researcher:stored",
      runId: "run-1",
      state: {},
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    expect(
      (
        await app.request(
          request(path, {
            method: "POST",
            headers: {
              origin: "http://attacker.test",
              "content-type": "application/json",
            },
            body: validBody,
          })
        )
      ).status
    ).toBe(403)
    expect(
      (
        await app.request(
          request(path, {
            method: "POST",
            headers: { origin },
            body: validBody,
          })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await app.request(
          request(path, {
            method: "POST",
            headers: {
              origin,
              "content-type": "application/json",
              "content-length": "1100001",
            },
            body: validBody,
          })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await app.request(
          request(path, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ oversized: "é".repeat(550_001) }),
          })
        )
      ).status
    ).toBe(400)
    expect(nativeHttp).not.toHaveBeenCalled()
    expect(nativeRequest).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it("rejects browser run authority beyond one new user turn", async () => {
    const nativeRequest = vi.fn()
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: nativeRequest,
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
        observeEvents: vi.fn(),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const route =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs"
    const base = {
      threadId: "hermes:researcher:stored",
      runId: "run-1",
      state: {},
      messages: [{ id: "user-new", role: "user", content: "New" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }
    const forbidden = [
      {
        ...base,
        messages: [
          { id: "user-old", role: "user", content: "Old" },
          ...base.messages,
        ],
      },
      { ...base, state: { native: true } },
      {
        ...base,
        tools: [
          { name: "browser_tool", description: "unsafe", parameters: {} },
        ],
      },
      { ...base, context: [{ description: "role", value: "admin" }] },
      { ...base, forwardedProps: { provider: "native" } },
      { ...base, resume: [{ interruptId: "native", payload: "unsafe" }] },
      { ...base, native_session_id: "live-secret" },
    ]

    for (const candidate of forbidden) {
      const response = await app.request(
        request(route, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(candidate),
        })
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: { code: "invalid_request" },
      })
    }
    expect(nativeRequest).not.toHaveBeenCalled()
  })

  it("returns a precise conflict for duplicate admission and redacts setup outages", async () => {
    const pending = new Promise<void>(() => undefined)
    const start = vi
      .fn()
      .mockResolvedValueOnce({
        events: (async function* () {
          await pending
          yield {
            type: "RUN_FINISHED" as const,
            threadId: "hermes:researcher:stored",
            runId: "run-1",
            outcome: { type: "success" as const },
          }
        })(),
        stop: vi.fn(async () => "stopping" as const),
        disconnect: vi.fn(),
        recoveryPosition: () => ({ epoch: "secret-epoch", lastSeen: 0 }),
      })
      .mockRejectedValueOnce(
        new HermesRunPublicError(
          "AOS_PROVIDER_UNAVAILABLE",
          "native https://secret.invalid failed with token=secret"
        )
      )
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: vi.fn(),
        http: vi.fn(async (path: string) => ({
          id: path.includes("/other?") ? "other" : "stored",
          profile: "researcher",
          title: "Owned",
        })),
      }),
      runEngine: { start } as unknown as HermesRunEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const runRequest = (threadId: string, runId: string) =>
      request(
        `/api/aos/v1/agents/researcher/sessions/${encodeURIComponent(threadId)}/runs`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            threadId,
            runId,
            state: {},
            messages: [{ id: `user-${runId}`, role: "user", content: "Hello" }],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        }
      )

    expect(
      (await app.request(runRequest("hermes:researcher:stored", "run-1")))
        .status
    ).toBe(200)
    const conflict = await app.request(
      runRequest("hermes:researcher:stored", "run-2")
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: "run_conflict" } })
    expect(start).toHaveBeenCalledTimes(1)

    const outage = await app.request(
      runRequest("hermes:researcher:other", "run-3")
    )
    expect(outage.status).toBe(503)
    expect(await outage.text()).toBe(
      JSON.stringify({ error: { code: "temporarily_unavailable" } })
    )
    expect(start).toHaveBeenCalledTimes(2)
  })

  it("caps global active runs before Session or native run I/O", async () => {
    const pending = new Promise<void>(() => undefined)
    const start = vi.fn(async () => ({
      events: (async function* () {
        await pending
        yield {
          type: "RUN_FINISHED" as const,
          threadId: "hermes:researcher:first",
          runId: "run-first",
          outcome: { type: "success" as const },
        }
      })(),
      stop: vi.fn(async () => "stopping" as const),
      disconnect: vi.fn(),
      recoveryPosition: () => ({ epoch: "opaque", lastSeen: 0 }),
    }))
    const nativeHttp = vi.fn(async (path: string) => ({
      id: path.includes("/first?") ? "first" : "second",
      profile: "researcher",
      title: "Owned",
    }))
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({ request: vi.fn(), http: nativeHttp }),
      runEngine: { start } as unknown as HermesRunEngine,
      maxActiveRuns: 1,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const runRequest = (storedId: string, runId: string) => {
      const threadId = `hermes:researcher:${storedId}`
      return request(
        `/api/aos/v1/agents/researcher/sessions/${encodeURIComponent(threadId)}/runs`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            threadId,
            runId,
            state: {},
            messages: [{ id: `user-${runId}`, role: "user", content: "Hello" }],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        }
      )
    }

    expect((await app.request(runRequest("first", "run-first"))).status).toBe(
      200
    )
    const sameScope = await app.request(runRequest("first", "run-duplicate"))
    expect(sameScope.status).toBe(409)
    expect(await sameScope.json()).toEqual({ error: { code: "run_conflict" } })
    const atCapacity = await app.request(runRequest("second", "run-second"))
    expect(atCapacity.status).toBe(503)
    expect(await atCapacity.json()).toEqual({
      error: { code: "run_capacity_exceeded" },
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(nativeHttp).toHaveBeenCalledTimes(1)
  })

  it("releases run admission after credential acquisition times out", async () => {
    let releaseLateCredentials: (() => void) | undefined
    const lateCredentials = new Promise<void>((resolve) => {
      releaseLateCredentials = resolve
    })
    let credentialCalls = 0
    const fetcher = vi.fn(async () =>
      Response.json({ id: "stored", profile: "researcher", title: "Owned" })
    )
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => {
        credentialCalls += 1
        if (credentialCalls === 1) await lateCredentials
        return { "X-Hermes-Session-Token": "native-secret" }
      },
      fetcher,
      socketFactory: vi.fn(),
      timeoutMs: 20,
    })
    const start = vi.fn(async () => ({
      events: (async function* () {
        yield {
          type: "RUN_FINISHED" as const,
          threadId: "hermes:researcher:stored",
          runId: "run-retry",
          outcome: { type: "success" as const },
        }
      })(),
      stop: vi.fn(async () => "idle" as const),
      disconnect: vi.fn(),
      recoveryPosition: () => ({ epoch: "opaque", lastSeen: 0 }),
    }))
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter(transport),
      runEngine: { start } as unknown as HermesRunEngine,
      maxActiveRuns: 1,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const runRequest = (runId: string) =>
      request(
        "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "hermes:researcher:stored",
            runId,
            state: {},
            messages: [{ id: `user-${runId}`, role: "user", content: "Hello" }],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        }
      )

    expect((await app.request(runRequest("run-timeout"))).status).toBe(503)
    expect((await app.request(runRequest("run-retry"))).status).toBe(200)
    releaseLateCredentials?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(start).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("fences an uncertain native send without retrying or disclosing its error", async () => {
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === "session.resume") return { session_id: "live-secret" }
      if (method === "session.events.since")
        return { epoch: "epoch-secret", last_seen: 0, events: [] }
      if (method === "session.active_list") return { sessions: [] }
      if (method === "prompt.submit")
        throw new Error(
          "POST https://native.invalid/private failed token=native-secret"
        )
      throw new Error(`unexpected ${method}`)
    })
    const app = createProxyApp({
      publicOrigin: origin,
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: nativeRequest,
        http: vi.fn(async () => ({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })),
        observeEvents: vi.fn(async () => () => undefined),
      }),
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const body = JSON.stringify({
      threadId: "hermes:researcher:stored",
      runId: "run-uncertain",
      state: {},
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })
    const route =
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs"

    const response = await app.request(
      request(route, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body,
      })
    )
    expect(response.status).toBe(200)
    const stream = await response.text()
    expect(stream).toContain('"type":"RUN_STARTED"')
    expect(stream).toContain('"code":"AOS_SEND_UNCERTAIN"')
    expect(
      nativeRequest.mock.calls.filter(([method]) => method === "prompt.submit")
    ).toHaveLength(1)
    for (const leak of [
      "live-secret",
      "epoch-secret",
      "native.invalid",
      "native-secret",
      "/private",
    ])
      expect(stream).not.toContain(leak)

    const duplicate = await app.request(
      request(route, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: body.replace("run-uncertain", "run-duplicate"),
      })
    )
    expect(duplicate.status).toBe(409)
    expect(
      nativeRequest.mock.calls.filter(([method]) => method === "prompt.submit")
    ).toHaveLength(1)
  })

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
    ).toEqual([
      { title: "Renamed", profile: "researcher" },
      { archived: true, profile: "researcher" },
      { archived: false, profile: "researcher" },
    ])
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

    const runtimeAuth = await app.request(request("/api/aos/v1/auth/runtime"))
    expect(await runtimeAuth.json()).toEqual({ status: "authenticated" })

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
