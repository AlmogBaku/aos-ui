// @vitest-environment node

import { SignJWT } from "jose"
import { describe, expect, it, vi } from "vitest"

import {
  createGuestInvitationService,
  type GuestInvitationService,
} from "../auth/guest-invitation"
import type {
  RuntimeInstance,
  ServerRunEngine,
  ServerRuntime,
} from "../core/runtime"
import { SessionCoordinator } from "../core/session-coordinator"
import { createGuestApp } from "./app"

const NOW = 1_700_000_000_000
const ORIGIN = "https://guest.example.test"
const AGENT = "researcher"
const REF = "guest_ref"
const STORED = "stored-session"
const KEY = new Uint8Array(32).fill(7)

function invitations() {
  return createGuestInvitationService({
    issuer: "aos-invite",
    audience: "aos-guest",
    deploymentId: "deployment-a",
    runtimeId: "hermes-primary",
    keys: [{ id: "current", secret: KEY }],
    now: () => NOW,
    ttlSeconds: 259_200,
  })
}

function workspaceCapabilities() {
  return {
    agent: {
      identity: { type: "hermes", provider: "private-provider" },
      transport: { streaming: true, resumable: true },
      reasoning: { supported: true, streaming: true },
      multimodal: {
        input: { image: true, audio: false, file: true },
        output: { audio: false },
      },
      humanInTheLoop: {
        supported: true,
        approvals: true,
        interrupts: true,
      },
    },
    workspace: {
      models: {
        status: "available",
        scope: "attached-session",
        selection: "native-session",
        choices: "provider-reported",
      },
      context: {
        status: "available",
        scope: "attached-session",
        source: "provider-usage-or-estimate",
        breakdown: "provider-categories",
      },
      todos: { status: "unavailable", reason: "not-supported" },
      activity: { status: "unavailable", reason: "not-supported" },
    },
    interactions: {
      steering: { status: "unavailable", reason: "not-supported" },
      approvals: {
        status: "available",
        protocol: "ag-ui-interrupt",
        scope: "run",
        choices: [
          { value: "once", scope: "request" },
          { value: "session", scope: "session" },
          { value: "always", scope: "agent" },
          { value: "deny", scope: "request" },
        ],
        maxPending: 1,
      },
      questions: {
        status: "available",
        protocol: "ag-ui-interrupt",
        scope: "run",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-empty-answer",
        maxQuestions: 10,
        maxChoicesPerQuestion: 10,
        maxAnswerValuesPerQuestion: 10,
        maxStringBytes: 2_000,
      },
      reactions: { status: "unavailable", reason: "not-supported" },
    },
    content: {
      attachments: {
        status: "available",
        scope: "attached-session",
        inputs: ["image", "file"],
        imageMimeTypes: ["image/png"],
        fileMimeTypes: "valid-type/subtype",
        maxMimeTypeBytes: 256,
        maxFilenameBytes: 4_096,
        maxCount: 8,
        maxImageBytes: 1_000_000,
        maxFileBytes: 1_000_000,
        maxTotalBytes: 2_000_000,
      },
      artifacts: { status: "available", scope: "session", maxBytes: 1_000_000 },
      transcription: { status: "unavailable", reason: "not-supported" },
      speech: { status: "unavailable", reason: "not-supported" },
    },
  }
}

function harness(options: { existing?: boolean } = {}) {
  const engine: ServerRunEngine = { start: vi.fn(), recover: vi.fn() }
  const resolveInvitedSession = vi.fn(
    async (_agent: string, _ref: string, create?: object) =>
      options.existing || create
        ? { sessionId: STORED, created: !options.existing }
        : undefined
  )
  const runtime = {
    runs: engine,
    resolveInvitedSession,
    runtimeInfo: vi.fn(async () => ({
      runtime: { id: "hermes-primary", name: "Hermes" },
      status: "ready",
      capabilities: {
        agentCatalog: { status: "available" },
        agentVisibility: { status: "available" },
        sessionCatalog: {
          status: "available",
          scope: "workspace",
          order: "recent",
          defaultPageSize: 50,
          maxPageSize: 100,
          maxWindow: 1_000,
        },
        sessionHistory: {
          status: "available",
          order: "chronological",
          compacted: true,
          loading: "on-open",
          defaultPageSize: 200,
          maxPageSize: 500,
        },
        sessionDetail: { status: "available" },
        sessionCreation: { status: "available" },
        sessionTitle: { status: "available" },
        sessionArchival: { status: "available" },
        sessionDeletion: { status: "available" },
        sessionRun: { status: "available" },
        sessionStop: { status: "available" },
        sessionSteer: { status: "available" },
        sessionReadState: { status: "available" },
      },
    })),
    workspaceCapabilities: vi.fn(workspaceCapabilities),
    getSession: vi.fn(async () => ({
      id: STORED,
      agentId: AGENT,
      title: "Invite",
      archived: false,
      updatedAt: "2026-09-15T00:00:00.000Z",
      status: "idle",
    })),
    history: vi.fn(async () => ({
      sessionId: STORED,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: [
            { type: "text", text: "Safe answer" },
            { type: "reasoning", text: "private reasoning" },
          ],
          createdAt: "2026-09-15T00:00:00.000Z",
          status: { type: "requires-action", reason: "interrupt" },
          metadata: {
            custom: {
              agui: {
                interrupts: [
                  {
                    id: "question-1",
                    reason: "question",
                    message: "Continue?",
                    responseSchema: { type: "boolean" },
                  },
                ],
              },
            },
          },
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
      nextOffset: 1,
    })),
    stageAttachments: vi.fn(async () => ({
      public: [{ type: "file", filename: "note.txt", mimeType: "text/plain" }],
      appendTo: (text: string) => `${text}\n@file:note.txt`,
      cleanup: vi.fn(async () => undefined),
    })),
    transcribe: vi.fn(async () => "hello"),
    speak: vi.fn(async () => ({
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: "audio/mpeg",
    })),
    publicError: vi.fn(() => undefined),
  } as unknown as ServerRuntime
  const instance: RuntimeInstance = {
    id: "hermes-primary",
    runtime,
    sessions: new SessionCoordinator({
      engine,
      maxActiveExecutions: 8,
      maxGuestActiveExecutions: 4,
      maxSubscriberEvents: 32,
      maxSubscriberBytes: 256 * 1024,
      maxReplayEvents: 64,
      maxReplayBytes: 512 * 1024,
    }),
    close: vi.fn(async () => undefined),
  }
  const invitationService = invitations()
  return {
    app: createGuestApp({
      publicOrigin: ORIGIN,
      runtime: instance,
      invitations: invitationService,
      now: () => NOW,
    }),
    runtime,
    engine,
    resolveInvitedSession,
    invitationService,
  }
}

async function token(service: GuestInvitationService) {
  return (
    await service.issue({
      agentId: AGENT,
      ref: REF,
      firstTurn: {
        instruction: "Load the interview skill.",
        prefill: "Hello",
      },
      ui: {
        lang: "he",
        name: "Interview host",
        logoUrl: "https://example.test/host.png",
        accent: "#2563eb",
        title: "Interview",
        message: "Welcome.",
      },
    })
  ).token
}

async function scopedToken(overrides: Record<string, unknown>) {
  return new SignJWT({
    v: 1,
    iss: "aos-invite",
    aud: "aos-guest",
    dep: "deployment-a",
    runtime: "hermes-primary",
    iat: NOW / 1_000,
    exp: NOW / 1_000 + 259_200,
    agent: AGENT,
    ref: REF,
    ...overrides,
  })
    .setProtectedHeader({
      alg: "HS256",
      kid: "current",
      typ: "aos-guest-invitation+jwt",
    })
    .sign(KEY)
}

function headers(value: string, withOrigin = false) {
  return {
    authorization: `Bearer ${value}`,
    ...(withOrigin ? { origin: ORIGIN } : {}),
  }
}

describe("guest app", () => {
  it("returns verified context without creating a missing Session", async () => {
    const subject = harness()
    const invite = await token(subject.invitationService)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/runtime`,
      {
        headers: headers(invite),
      }
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      runtimeId: "hermes-primary",
      agentId: AGENT,
      conversationRef: REF,
      ui: {
        lang: "he",
        name: "Interview host",
        logoUrl: "https://example.test/host.png",
        accent: "#2563eb",
        title: "Interview",
        message: "Welcome.",
      },
      prefill: "Hello",
      expiresAt: "2023-11-17T22:13:20.000Z",
    })
    expect(JSON.stringify(body)).not.toContain("private-provider")
    expect(JSON.stringify(body)).not.toContain("reasoning")
    expect(JSON.stringify(body)).not.toContain("models")
    expect(subject.resolveInvitedSession).toHaveBeenCalledWith(AGENT, REF)
    expect(subject.resolveInvitedSession).not.toHaveBeenCalledWith(
      AGENT,
      REF,
      expect.anything()
    )
  })

  it("stages first-Send attachments without creating a Session", async () => {
    const subject = harness()
    const invite = await token(subject.invitationService)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/attachments/stage`,
      {
        method: "POST",
        headers: {
          ...headers(invite, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attachments: [
            {
              type: "file",
              filename: "note.txt",
              mimeType: "text/plain",
              dataUrl: "data:text/plain;base64,aGVsbG8=",
            },
          ],
        }),
      }
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      stageId: expect.any(String),
    })
    // The invited Session is created by the first ACP prompt, not by staging.
    expect(subject.resolveInvitedSession).not.toHaveBeenCalled()
    expect(subject.runtime.stageAttachments).not.toHaveBeenCalled()
  })

  it("returns warm copy for an invalid invitation and exposes no browser wire", async () => {
    const subject = harness()

    const invalid = await subject.app.request(
      `${ORIGIN}/api/guest/v1/runtime`,
      { headers: headers("invalid") }
    )

    expect(invalid.status).toBe(401)
    await expect(invalid.json()).resolves.toEqual({
      error: {
        code: "invitation_inactive",
        description:
          "This invitation link is no longer active. Please ask the person who invited you to send a new one.",
      },
    })

    // History, runs, and the invalidation socket all travel over guest ACP now.
    for (const path of [
      `${ORIGIN}/api/guest/v1/events`,
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/history`,
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/runs`,
    ])
      expect(
        (await subject.app.request(path, { headers: headers("invalid") }))
          .status,
        path
      ).toBe(404)
  })

  it.each([
    ["expired", { exp: NOW / 1_000 - 1 }],
    ["wrong audience", { aud: "other" }],
    ["wrong deployment", { dep: "deployment-b" }],
    ["wrong runtime", { runtime: "other-runtime" }],
    ["wrong Agent", { agent: "other-agent" }],
    ["wrong reference", { ref: "other-ref" }],
  ])("rejects %s before runtime access", async (_name, overrides) => {
    const subject = harness()
    const invite = await scopedToken(overrides)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/attachments/stage`,
      {
        method: "POST",
        headers: {
          ...headers(invite, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attachments: [
            {
              type: "file",
              filename: "note.txt",
              mimeType: "text/plain",
              dataUrl: "data:text/plain;base64,aGVsbG8=",
            },
          ],
        }),
      }
    )

    expect(response.status).toBe(401)
    expect(subject.resolveInvitedSession).not.toHaveBeenCalled()
    expect(subject.runtime.stageAttachments).not.toHaveBeenCalled()
  })

  it("rejects a wrong Origin before runtime access", async () => {
    const subject = harness()
    const invite = await token(subject.invitationService)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/attachments/stage`,
      {
        method: "POST",
        headers: {
          ...headers(invite),
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: "{}",
      }
    )

    expect(response.status).toBe(403)
    expect(subject.resolveInvitedSession).not.toHaveBeenCalled()
    expect(subject.runtime.stageAttachments).not.toHaveBeenCalled()
  })

  it("returns a normalized friendly error when the selected runtime is unavailable", async () => {
    const subject = harness()
    subject.resolveInvitedSession.mockRejectedValueOnce(
      new Error("private provider failure")
    )
    const invite = await token(subject.invitationService)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/runtime`,
      { headers: headers(invite) }
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "temporarily_unavailable",
        description:
          "The service is temporarily unavailable. Please try again.",
      },
    })
  })

  it("invokes Agent-scoped audio without resolving or creating a Session", async () => {
    const subject = harness()
    const invite = await token(subject.invitationService)
    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/audio/transcribe`,
      {
        method: "POST",
        headers: {
          ...headers(invite, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mimeType: "audio/webm",
          dataUrl: "data:audio/webm;base64,AQID",
        }),
      }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ transcript: "hello" })
    expect(subject.runtime.transcribe).toHaveBeenCalledWith(
      AGENT,
      Uint8Array.of(1, 2, 3),
      "audio/webm",
      expect.any(AbortSignal)
    )
    expect(subject.resolveInvitedSession).not.toHaveBeenCalled()
  })
})
