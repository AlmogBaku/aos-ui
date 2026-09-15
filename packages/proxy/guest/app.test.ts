// @vitest-environment node

import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core"
import { SignJWT } from "jose"
import { describe, expect, it, vi } from "vitest"

import {
  createGuestInvitationService,
  type GuestInvitationService,
} from "../auth/guest-invitation"
import type {
  RuntimeInstance,
  ServerRunEngine,
  ServerRunHandle,
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

function terminalHandle(events: AGUIEvent[]): ServerRunHandle {
  return {
    events: (async function* () {
      yield* events
    })(),
    settled: Promise.resolve(),
    stop: vi.fn(async () => "idle" as const),
    recoveryPosition: () => ({ epoch: "native", lastSeen: events.length }),
  }
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

function harness(
  options: {
    existing?: boolean
    sessions?: RuntimeInstance["sessions"]
  } = {}
) {
  const engine: ServerRunEngine = {
    start: vi.fn(async (_scope, input) =>
      terminalHandle([
        { type: EventType.RUN_STARTED, threadId: REF, runId: input.runId },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "assistant-native",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "assistant-native",
          delta: "Guest-visible answer",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-native" },
        {
          type: EventType.RUN_FINISHED,
          threadId: REF,
          runId: input.runId,
          outcome: { type: "success" },
        },
      ])
    ),
    recover: vi.fn(),
  }
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
    sessions:
      options.sessions ??
      new SessionCoordinator({
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

  it("restores safe history and interrupt metadata through the public reference", async () => {
    const subject = harness({ existing: true })
    const invite = await token(subject.invitationService)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/history?limit=200&offset=0`,
      { headers: headers(invite) }
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.sessionId).toBe(REF)
    expect(JSON.stringify(body)).toContain("question-1")
    expect(JSON.stringify(body)).not.toContain("private reasoning")
    expect(subject.runtime.history).toHaveBeenCalledWith(AGENT, STORED, 200, 0)
  })

  it("returns empty history for a fresh invitation without creating a Session", async () => {
    const subject = harness()
    const invite = await token(subject.invitationService)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/history`,
      { headers: headers(invite) }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      sessionId: REF,
      messages: [],
      total: 0,
      execution: { status: "idle" },
    })
    expect(subject.runtime.history).not.toHaveBeenCalled()
    expect(subject.runtime.getSession).not.toHaveBeenCalled()
    expect(subject.resolveInvitedSession).toHaveBeenCalledWith(AGENT, REF)
    expect(subject.resolveInvitedSession).not.toHaveBeenCalledWith(
      AGENT,
      REF,
      expect.anything()
    )
  })

  it("creates lazily on first Send and starts exactly one normalized run", async () => {
    const subject = harness()
    const invite = await token(subject.invitationService)
    const verify = vi.spyOn(subject.invitationService, "verify")
    const input: RunAgentInput = {
      threadId: REF,
      runId: "run-1",
      state: {},
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/runs`,
      {
        method: "POST",
        headers: {
          ...headers(invite, true),
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }
    )
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain("Guest-visible answer")
    expect(verify).toHaveBeenCalledOnce()
    expect(subject.resolveInvitedSession).toHaveBeenCalledWith(AGENT, REF, {
      firstTurnInstruction: "Load the interview skill.",
    })
    expect(subject.engine.start).toHaveBeenCalledOnce()
    expect(subject.engine.start).toHaveBeenCalledWith(
      { agentId: AGENT, sessionId: STORED, threadId: REF },
      expect.objectContaining({ threadId: REF, runId: "run-1" })
    )
  })

  it("rejects an Agent-wide guest approval before runtime execution", async () => {
    const start = vi.fn()
    const sessions = {
      snapshot: vi.fn(() => ({
        state: "waiting-for-input" as const,
        runId: "run-before",
        interrupts: [{ id: "approval-1", reason: "approval" }],
      })),
      start,
    } as unknown as RuntimeInstance["sessions"]
    const subject = harness({ existing: true, sessions })
    const invite = await token(subject.invitationService)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/runs`,
      {
        method: "POST",
        headers: {
          ...headers(invite, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          threadId: REF,
          runId: "run-resume",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
          resume: [
            {
              interruptId: "approval-1",
              status: "resolved",
              payload: "always",
            },
          ],
        }),
      }
    )

    expect(response.status).toBe(400)
    expect(start).not.toHaveBeenCalled()
  })

  it("creates lazily while staging first-Send attachments and consumes the stage once", async () => {
    const subject = harness()
    const invite = await token(subject.invitationService)
    const stage = await subject.app.request(
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
    const staged = await stage.json()

    expect(stage.status).toBe(201)
    expect(subject.resolveInvitedSession).not.toHaveBeenCalled()
    expect(subject.runtime.stageAttachments).not.toHaveBeenCalled()

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/runs`,
      {
        method: "POST",
        headers: {
          ...headers(invite, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          threadId: REF,
          runId: "run-with-file",
          state: {},
          messages: [{ id: "user-1", role: "user", content: "Review" }],
          tools: [],
          context: [],
          forwardedProps: { aosAttachmentStageId: staged.stageId },
        }),
      }
    )
    await response.text()

    expect(response.status).toBe(200)
    expect(subject.resolveInvitedSession).toHaveBeenCalledWith(AGENT, REF, {
      firstTurnInstruction: "Load the interview skill.",
    })
    expect(subject.runtime.stageAttachments).toHaveBeenCalledWith(
      AGENT,
      STORED,
      expect.any(Array)
    )
    expect(subject.engine.start).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        messages: [
          expect.objectContaining({ content: "Review\n@file:note.txt" }),
        ],
      })
    )
  })

  it("returns warm copy for an invalid invitation and exposes no event socket", async () => {
    const subject = harness()

    const invalid = await subject.app.request(
      `${ORIGIN}/api/guest/v1/runtime`,
      { headers: headers("invalid") }
    )
    const events = await subject.app.request(`${ORIGIN}/api/guest/v1/events`, {
      headers: headers("invalid"),
    })

    expect(invalid.status).toBe(401)
    await expect(invalid.json()).resolves.toEqual({
      error: {
        code: "invitation_inactive",
        description:
          "This invitation link is no longer active. Please ask the person who invited you to send a new one.",
      },
    })
    expect(events.status).toBe(404)
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
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/history`,
      { headers: headers(invite) }
    )

    expect(response.status).toBe(401)
    expect(subject.resolveInvitedSession).not.toHaveBeenCalled()
    expect(subject.runtime.history).not.toHaveBeenCalled()
    expect(subject.engine.start).not.toHaveBeenCalled()
  })

  it("rejects a wrong Origin before runtime access", async () => {
    const subject = harness()
    const invite = await token(subject.invitationService)

    const response = await subject.app.request(
      `${ORIGIN}/api/guest/v1/agents/${AGENT}/sessions/${REF}/runs`,
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
    expect(subject.engine.start).not.toHaveBeenCalled()
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
