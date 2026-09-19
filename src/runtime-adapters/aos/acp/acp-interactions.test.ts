import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"

import { AOS_PERMISSION_KIND_SESSION } from "@aos/protocol/acp"
import { createAcpInteractions } from "./acp-interactions"
import type { AcpPendingRequest } from "./types"

function harness() {
  const listeners = new Set<(pending: AcpPendingRequest) => void>()
  const interactions = createAcpInteractions({
    connection: {
      onPendingRequest(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
  const emit = (pending: AcpPendingRequest) =>
    listeners.forEach((listener) => listener(pending))
  return { interactions, emit }
}

function permission({
  sessionId = "session-1",
  interruptId = "interrupt-1",
  description,
  message,
  meta,
}: {
  sessionId?: string
  interruptId?: string
  description?: string
  message?: string
  meta?: Record<string, unknown>
} = {}) {
  const respond = vi.fn<(response: RequestPermissionResponse) => void>()
  const request: RequestPermissionRequest = {
    sessionId,
    title: "Run the deploy script",
    ...(description === undefined ? {} : { description }),
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "allow-session",
        name: "Allow for this Session",
        kind: AOS_PERMISSION_KIND_SESSION,
      },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    _meta: meta ?? {
      aos: { interruptId, ...(message === undefined ? {} : { message }) },
    },
  }
  const pending: AcpPendingRequest = {
    kind: "permission",
    sessionId,
    request,
    respond,
  }
  return { pending, respond }
}

function elicitation({
  interruptId = "interrupt-2",
  requestScoped = false,
}: { interruptId?: string; requestScoped?: boolean } = {}) {
  const sessionId = requestScoped ? undefined : "session-1"
  const respond = vi.fn<(response: CreateElicitationResponse) => void>()
  const request: CreateElicitationRequest = {
    mode: "form",
    ...(sessionId === undefined ? { requestId: "rpc-7" } : { sessionId }),
    message: "The runtime needs two answers",
    requestedSchema: {
      type: "object",
      properties: {
        q0: { type: "string", enum: ["Yes", "No"] },
        q1: { type: "array", items: { type: "string", enum: ["eu", "IL"] } },
      },
    },
    _meta: {
      aos: {
        interruptId,
        questions: [
          {
            id: "confirm",
            header: "Confirm",
            prompt: "Continue the migration?",
            options: [{ label: "Yes" }, { label: "No" }],
            multiple: false,
            custom: false,
          },
          {
            header: "Regions",
            prompt: "Which regions?",
            options: [{ label: "EU", value: "eu" }, { label: "IL" }],
            multiple: true,
            custom: true,
          },
        ],
      },
    },
  }
  const pending: AcpPendingRequest = {
    kind: "elicitation",
    sessionId,
    request,
    respond,
  }
  return { pending, respond }
}

describe("ACP runtime interactions", () => {
  it("projects a permission request into one single-select question", () => {
    const { interactions, emit } = harness()
    emit(permission({ description: "The script writes to production" }).pending)

    expect(interactions.getPending("session-1")).toEqual({
      kind: "question",
      requestId: "interrupt-1",
      sessionId: "session-1",
      questions: [
        {
          header: "Run the deploy script",
          prompt: "The script writes to production",
          options: [
            { label: "Allow once", value: "allow-once" },
            { label: "Allow for this Session", value: "allow-session" },
            { label: "Reject", value: "reject" },
          ],
          multiple: false,
          custom: false,
        },
      ],
    })
  })

  it("falls back to the AOS message and to a generated id", () => {
    const { interactions, emit } = harness()
    emit(permission({ message: "Hermes needs approval" }).pending)
    expect(interactions.getPending("session-1")?.questions[0]?.prompt).toBe(
      "Hermes needs approval"
    )

    emit(permission({ sessionId: "session-2", meta: {} }).pending)
    const request = interactions.getPending("session-2")
    expect(request?.requestId).toMatch(/^acp-permission-/u)
    expect(request?.questions[0]?.prompt).toBe("")
  })

  it("carries the proxy's elicitation questions losslessly", () => {
    const { interactions, emit } = harness()
    emit(elicitation().pending)

    expect(interactions.getPending("session-1")).toEqual({
      kind: "question",
      requestId: "interrupt-2",
      sessionId: "session-1",
      questions: [
        {
          id: "confirm",
          header: "Confirm",
          prompt: "Continue the migration?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiple: false,
          custom: false,
        },
        {
          header: "Regions",
          prompt: "Which regions?",
          options: [{ label: "EU", value: "eu" }, { label: "IL" }],
          multiple: true,
          custom: true,
        },
      ],
    })
  })

  it("ignores an elicitation no Session can show", () => {
    const { interactions, emit } = harness()
    emit(elicitation({ requestScoped: true }).pending)

    expect(interactions.getPending("session-1")).toBeUndefined()
  })

  it("answers a permission with the selected option and clears the Session", async () => {
    const { interactions, emit } = harness()
    const { pending, respond } = permission()
    emit(pending)
    const request = interactions.getPending("session-1")!

    await interactions.respond(request, {
      kind: "question",
      answers: [["allow-session"]],
    })

    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: "selected", optionId: "allow-session" },
    })
    expect(interactions.getPending("session-1")).toBeUndefined()

    await interactions.respond(request, {
      kind: "question",
      answers: [["allow-once"]],
    })
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it("accepts an elicitation with one content key per question", async () => {
    const { interactions, emit } = harness()
    const { pending, respond } = elicitation()
    emit(pending)
    const request = interactions.getPending("session-1")!

    await interactions.respond(request, {
      kind: "question",
      answers: [["Yes"], ["eu", "IL"]],
    })

    expect(respond).toHaveBeenCalledWith({
      action: "accept",
      content: { q0: "Yes", q1: ["eu", "IL"] },
    })
    expect(interactions.getPending("session-1")).toBeUndefined()
  })

  it("cancels the native request it rejects", async () => {
    const { interactions, emit } = harness()
    const permissionRequest = permission()
    emit(permissionRequest.pending)
    await interactions.reject(interactions.getPending("session-1")!)
    expect(permissionRequest.respond).toHaveBeenCalledWith({
      outcome: { outcome: "cancelled" },
    })

    const elicitationRequest = elicitation()
    emit(elicitationRequest.pending)
    await interactions.reject(interactions.getPending("session-1")!)
    expect(elicitationRequest.respond).toHaveBeenCalledWith({
      action: "cancel",
    })
    expect(interactions.getPending("session-1")).toBeUndefined()
  })

  it("keeps pending requests scoped to their own Session", () => {
    const { interactions, emit } = harness()
    emit(permission({ sessionId: "session-1", interruptId: "one" }).pending)
    emit(permission({ sessionId: "session-2", interruptId: "two" }).pending)

    expect(interactions.getPending("session-1")?.requestId).toBe("one")
    expect(interactions.getPending("session-2")?.requestId).toBe("two")

    const superseded = permission({
      sessionId: "session-1",
      interruptId: "three",
    })
    emit(superseded.pending)
    expect(interactions.getPending("session-1")?.requestId).toBe("three")
    expect(interactions.getPending("session-2")?.requestId).toBe("two")
  })

  it("notifies only the Session's subscribers and stabilizes its snapshot", async () => {
    const { interactions, emit } = harness()
    const selected = vi.fn()
    const other = vi.fn()
    const unsubscribe = interactions.subscribe("session-1", selected)
    interactions.subscribe("session-2", other)

    emit(permission().pending)
    expect(selected).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    expect(interactions.getPending("session-1")).toBe(
      interactions.getPending("session-1")
    )

    await interactions.reject(interactions.getPending("session-1")!)
    expect(selected).toHaveBeenCalledTimes(2)

    unsubscribe()
    emit(permission().pending)
    expect(selected).toHaveBeenCalledTimes(2)
  })

  it("dismisses an unanswerable request without answering the runtime", () => {
    const { interactions, emit } = harness()
    const { pending, respond } = permission()
    emit(pending)
    const listener = vi.fn()
    interactions.subscribe("session-1", listener)

    interactions.dismiss?.(interactions.getPending("session-1")!)

    expect(respond).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(interactions.getPending("session-1")).toBeUndefined()
  })
})
