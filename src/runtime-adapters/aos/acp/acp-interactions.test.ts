import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"

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

/** Permissions are tool approvals, answered on the card of their tool call. */
function permission() {
  const respond = vi.fn<(response: RequestPermissionResponse) => void>()
  const request: RequestPermissionRequest = {
    sessionId: "session-1",
    title: "Run the deploy script",
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    _meta: { aos: { requestId: "interrupt-1" } },
  }
  const pending: AcpPendingRequest = {
    kind: "permission",
    sessionId: "session-1",
    request,
    respond,
    signal: new AbortController().signal,
  }
  return { pending, respond }
}

function elicitation({
  sessionId: scoped = "session-1",
  requestId = "interrupt-2",
  requestScoped = false,
}: { sessionId?: string; requestId?: string; requestScoped?: boolean } = {}) {
  const sessionId = requestScoped ? undefined : scoped
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
        requestId,
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
  const withdrawal = new AbortController()
  const pending: AcpPendingRequest = {
    kind: "elicitation",
    sessionId,
    request,
    respond,
    signal: withdrawal.signal,
  }
  return { pending, respond, withdraw: () => withdrawal.abort() }
}

describe("ACP runtime interactions", () => {
  it("leaves permission requests to the tool approvals", () => {
    const { interactions, emit } = harness()
    const listener = vi.fn()
    interactions.subscribe("session-1", listener)
    const { pending, respond } = permission()

    emit(pending)

    expect(interactions.getPending("session-1")).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
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

  it("leaves an unreadable elicitation pending instead of answering it", () => {
    const { interactions, emit } = harness()
    const shown = elicitation()
    emit(shown.pending)
    const unreadable = elicitation({ requestId: "interrupt-3" })
    // The proxy carries the questions only here, and this contract rejects an
    // empty header, so there is nothing the composer could render.
    unreadable.pending.request._meta = {
      aos: { requestId: "interrupt-3", questions: [{ header: "" }] },
    }

    expect(() => emit(unreadable.pending)).not.toThrow()
    expect(unreadable.respond).not.toHaveBeenCalled()
    expect(interactions.getPending("session-1")?.requestId).toBe("interrupt-2")
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

    await interactions.respond(request, {
      kind: "question",
      answers: [["No"], []],
    })
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it("cancels the native request it rejects", async () => {
    const { interactions, emit } = harness()
    const { pending, respond } = elicitation()
    emit(pending)
    await interactions.reject(interactions.getPending("session-1")!)

    expect(respond).toHaveBeenCalledWith({ action: "cancel" })
    expect(interactions.getPending("session-1")).toBeUndefined()
  })

  it("keeps pending requests scoped to their own Session", () => {
    const { interactions, emit } = harness()
    emit(elicitation({ sessionId: "session-1", requestId: "one" }).pending)
    emit(elicitation({ sessionId: "session-2", requestId: "two" }).pending)

    expect(interactions.getPending("session-1")?.requestId).toBe("one")
    expect(interactions.getPending("session-2")?.requestId).toBe("two")

    emit(elicitation({ sessionId: "session-1", requestId: "three" }).pending)
    expect(interactions.getPending("session-1")?.requestId).toBe("three")
    expect(interactions.getPending("session-2")?.requestId).toBe("two")
  })

  it("notifies only the Session's subscribers and stabilizes its snapshot", async () => {
    const { interactions, emit } = harness()
    const selected = vi.fn()
    const other = vi.fn()
    const unsubscribe = interactions.subscribe("session-1", selected)
    interactions.subscribe("session-2", other)

    emit(elicitation().pending)
    expect(selected).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    expect(interactions.getPending("session-1")).toBe(
      interactions.getPending("session-1")
    )

    await interactions.reject(interactions.getPending("session-1")!)
    expect(selected).toHaveBeenCalledTimes(2)

    unsubscribe()
    emit(elicitation().pending)
    expect(selected).toHaveBeenCalledTimes(2)
  })

  it("dismisses an unanswerable request without answering the runtime", () => {
    const { interactions, emit } = harness()
    const { pending, respond } = elicitation()
    emit(pending)
    const listener = vi.fn()
    interactions.subscribe("session-1", listener)

    interactions.dismiss?.(interactions.getPending("session-1")!)

    expect(respond).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(interactions.getPending("session-1")).toBeUndefined()
  })

  it("clears a question another UI answered without answering the runtime", () => {
    const { interactions, emit } = harness()
    const { pending, respond, withdraw } = elicitation()
    emit(pending)
    const listener = vi.fn()
    interactions.subscribe("session-1", listener)

    withdraw()

    expect(interactions.getPending("session-1")).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(respond).not.toHaveBeenCalled()
  })

  it("keeps another Session's question that shares the withdrawn request id", () => {
    const { interactions, emit } = harness()
    const withdrawn = elicitation({ sessionId: "session-1" })
    emit(withdrawn.pending)
    emit(elicitation({ sessionId: "session-2" }).pending)

    withdrawn.withdraw()

    expect(interactions.getPending("session-1")).toBeUndefined()
    expect(interactions.getPending("session-2")?.requestId).toBe("interrupt-2")
  })

  it("keeps the newer question when a superseded one is withdrawn", () => {
    const { interactions, emit } = harness()
    const superseded = elicitation({ requestId: "interrupt-1" })
    emit(superseded.pending)
    emit(elicitation({ requestId: "interrupt-2" }).pending)

    superseded.withdraw()

    expect(interactions.getPending("session-1")?.requestId).toBe("interrupt-2")
  })
})
