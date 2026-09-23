import type {
  CreateElicitationRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AOS_PERMISSION_KIND_SESSION } from "@aos/protocol/acp"
import { createAcpApprovals } from "./acp-approvals"
import type { AcpPendingRequest } from "./types"

function harness() {
  const listeners = new Set<(pending: AcpPendingRequest) => void>()
  const approvals = createAcpApprovals({
    connection: {
      onPendingRequest(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
  const emit = (pending: AcpPendingRequest) =>
    listeners.forEach((listener) => listener(pending))
  return { approvals, emit }
}

function permission({
  sessionId = "session-1",
  requestId = "interrupt-1",
  title = "Run the deploy script",
  toolCallId,
  description,
  message,
  expiresAt,
  meta,
}: {
  sessionId?: string
  requestId?: string
  title?: string
  toolCallId?: string
  description?: string
  message?: string
  expiresAt?: string
  meta?: Record<string, unknown>
} = {}) {
  const respond = vi.fn<(response: RequestPermissionResponse) => void>()
  const request: RequestPermissionRequest = {
    sessionId,
    title,
    ...(description === undefined ? {} : { description }),
    ...(toolCallId === undefined
      ? {}
      : { subject: { type: "tool_call", toolCall: { toolCallId } } }),
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "session",
        name: "Allow for this Session",
        kind: AOS_PERMISSION_KIND_SESSION,
      },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
      { optionId: "never", name: "Never", kind: "reject_always" },
    ],
    _meta: meta ?? {
      aos: {
        requestId,
        ...(message === undefined ? {} : { message }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    },
  }
  // The proxy withdraws a request by aborting its signal.
  const withdrawal = new AbortController()
  const pending: AcpPendingRequest = {
    kind: "permission",
    sessionId,
    request,
    respond,
    signal: withdrawal.signal,
  }
  return { pending, respond, withdraw: () => withdrawal.abort() }
}

function elicitation(): AcpPendingRequest {
  const request: CreateElicitationRequest = {
    mode: "form",
    sessionId: "session-1",
    message: "Continue?",
    requestedSchema: { type: "object", properties: {} },
    _meta: { aos: { requestId: "interrupt-9", questions: [] } },
  }
  return {
    kind: "elicitation",
    sessionId: "session-1",
    request,
    respond: vi.fn(),
    signal: new AbortController().signal,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("ACP permission approvals", () => {
  it("projects a permission onto the tool call it guards", () => {
    const { approvals, emit } = harness()
    emit(
      permission({
        toolCallId: "call-1",
        description: "The script writes to production",
      }).pending
    )

    expect(approvals.list("session-1")).toEqual([
      {
        id: "interrupt-1",
        toolCallId: "call-1",
        action: "Run the deploy script",
        description: "The script writes to production",
        // Standard kinds carry no label, so the card localizes them.
        options: [
          { id: "once", kind: "allow-once" },
          { id: "session", kind: AOS_PERMISSION_KIND_SESSION },
          { id: "always", kind: "allow-always" },
          { id: "deny", kind: "reject-once" },
          { id: "never", kind: "reject-always" },
        ],
      },
    ])
  })

  it("keeps both the operation Hermes names and its explanation", () => {
    const { approvals, emit } = harness()
    emit(
      permission({
        title: "rm -rf /tmp/build",
        description: "Hermes flagged a recursive delete",
      }).pending
    )
    expect(approvals.list("session-1")[0]).toMatchObject({
      action: "rm -rf /tmp/build",
      description: "Hermes flagged a recursive delete",
    })
  })

  it("falls back to the AOS message, the title alone, and a generated id", () => {
    const { approvals, emit } = harness()
    emit(permission({ message: "Hermes needs approval" }).pending)
    expect(approvals.list("session-1")[0]).toMatchObject({
      action: "Run the deploy script",
      description: "Hermes needs approval",
    })
    expect(approvals.list("session-1")[0]?.toolCallId).toBeUndefined()

    emit(permission({ sessionId: "session-2", meta: {} }).pending)
    const [generated] = approvals.list("session-2")
    expect(generated?.id).toMatch(/^acp-permission-/u)
    expect(generated?.action).toBe("Run the deploy script")
    expect(generated?.description).toBeUndefined()

    // A message that only repeats the title explains nothing more.
    emit(
      permission({ sessionId: "session-3", message: "Run the deploy script" })
        .pending
    )
    expect(approvals.list("session-3")[0]?.description).toBeUndefined()
  })

  it("keeps the provider's name for an option kind it does not know", () => {
    const { approvals, emit } = harness()
    const { pending } = permission()
    pending.request.options = [
      { optionId: "sandbox", name: "Run in a sandbox", kind: "_sandbox" },
    ]
    emit(pending)

    expect(approvals.list("session-1")[0]?.options).toEqual([
      { id: "sandbox", kind: "_sandbox", label: "Run in a sandbox" },
    ])
  })

  it("ignores elicitations", () => {
    const { approvals, emit } = harness()
    emit(elicitation())
    expect(approvals.list("session-1")).toEqual([])
  })

  it("answers with the native option and records the choice", async () => {
    const { approvals, emit } = harness()
    const { pending, respond } = permission({ toolCallId: "call-1" })
    emit(pending)

    await approvals.respond("session-1", "interrupt-1", "session", true)

    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: "selected", optionId: "session" },
    })
    expect(approvals.list("session-1")[0]).toMatchObject({
      optionId: "session",
      approved: true,
    })
  })

  it("records the verdict it is given with the option", async () => {
    const { approvals, emit } = harness()
    const { pending } = permission()
    // Nothing in this kind's spelling says whether it refuses.
    pending.request.options = [
      { optionId: "quietly", name: "Skip quietly", kind: "_skip" },
    ]
    emit(pending)

    await approvals.respond("session-1", "interrupt-1", "quietly", false)

    expect(approvals.list("session-1")[0]).toMatchObject({
      optionId: "quietly",
      approved: false,
    })
  })

  it("refuses to answer a settled, unknown, or foreign request", async () => {
    const { approvals, emit } = harness()
    const { pending, respond } = permission()
    emit(pending)
    await approvals.respond("session-1", "interrupt-1", "once", true)

    await expect(
      approvals.respond("session-1", "interrupt-1", "deny", false)
    ).rejects.toThrow()
    await expect(
      approvals.respond("session-1", "missing", "once", true)
    ).rejects.toThrow()
    await expect(
      approvals.respond("session-2", "interrupt-1", "once", true)
    ).rejects.toThrow()
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it("refuses an option the request does not offer", async () => {
    const { approvals, emit } = harness()
    const { pending, respond } = permission()
    emit(pending)

    await expect(
      approvals.respond("session-1", "interrupt-1", "everything", true)
    ).rejects.toThrow()
    expect(respond).not.toHaveBeenCalled()
  })

  it("cancels a withdrawn standalone request without answering it", () => {
    const { approvals, emit } = harness()
    const { pending, respond, withdraw } = permission()
    emit(pending)
    const listener = vi.fn()
    approvals.subscribe("session-1", listener)

    withdraw()

    expect(approvals.list("session-1")[0]).toMatchObject({
      resolution: "cancelled",
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(respond).not.toHaveBeenCalled()
  })

  it("removes a withdrawn request that guards a tool call", () => {
    const { approvals, emit } = harness()
    const { pending, withdraw } = permission({ toolCallId: "call-1" })
    emit(pending)

    withdraw()

    // The tool may run after all, so its card never reads "Cancelled".
    expect(approvals.list("session-1")).toEqual([])
  })

  it("keeps the chosen option when the answered request is withdrawn", async () => {
    const { approvals, emit } = harness()
    const { pending, withdraw } = permission({ toolCallId: "call-1" })
    emit(pending)
    await approvals.respond("session-1", "interrupt-1", "once", true)

    withdraw()

    expect(approvals.list("session-1")[0]).toMatchObject({ optionId: "once" })
  })

  it("expires a request at its deadline without answering it", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-23T10:00:00Z") })
    const { approvals, emit } = harness()
    const { pending, respond } = permission({
      expiresAt: "2026-09-23T10:01:00Z",
    })
    emit(pending)
    const listener = vi.fn()
    approvals.subscribe("session-1", listener)

    vi.advanceTimersByTime(59_999)
    expect(approvals.list("session-1")[0]?.resolution).toBeUndefined()
    vi.advanceTimersByTime(1)

    expect(approvals.list("session-1")[0]).toMatchObject({
      resolution: "expired",
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(respond).not.toHaveBeenCalled()
    await expect(
      approvals.respond("session-1", "interrupt-1", "once", true)
    ).rejects.toThrow()
  })

  it("does not expire a request whose deadline is beyond the timer's range", () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-23T10:00:00Z") })
    const { approvals, emit } = harness()
    // Thirty days out overflows `setTimeout`, which would fire at once.
    emit(permission({ expiresAt: "2026-10-23T10:00:00Z" }).pending)

    vi.advanceTimersByTime(60_000)

    expect(approvals.list("session-1")[0]?.resolution).toBeUndefined()
  })

  it("never expires a request it has answered", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-23T10:00:00Z") })
    const { approvals, emit } = harness()
    emit(permission({ expiresAt: "2026-09-23T10:01:00Z" }).pending)
    await approvals.respond("session-1", "interrupt-1", "once", true)

    vi.advanceTimersByTime(120_000)

    expect(approvals.list("session-1")[0]).toMatchObject({ optionId: "once" })
    expect(approvals.list("session-1")[0]?.resolution).toBeUndefined()
  })

  it("replaces a re-issued request with the same id", async () => {
    const { approvals, emit } = harness()
    const first = permission()
    emit(first.pending)
    const reissued = permission({ description: "Re-issued after reconnect" })
    emit(reissued.pending)

    expect(approvals.list("session-1")).toHaveLength(1)
    expect(approvals.list("session-1")[0]?.description).toBe(
      "Re-issued after reconnect"
    )

    // The superseded copy's withdrawal leaves the live one alone.
    first.withdraw()
    expect(approvals.list("session-1")[0]?.resolution).toBeUndefined()

    await approvals.respond("session-1", "interrupt-1", "once", true)
    expect(reissued.respond).toHaveBeenCalledTimes(1)
    expect(first.respond).not.toHaveBeenCalled()
  })

  it("keeps each Session's requests and listeners apart", () => {
    const { approvals, emit } = harness()
    const selected = vi.fn()
    const other = vi.fn()
    const unsubscribe = approvals.subscribe("session-1", selected)
    approvals.subscribe("session-2", other)

    emit(permission({ requestId: "one" }).pending)
    emit(permission({ requestId: "two" }).pending)
    emit(permission({ sessionId: "session-2", requestId: "three" }).pending)

    expect(approvals.list("session-1").map(({ id }) => id)).toEqual([
      "one",
      "two",
    ])
    expect(approvals.list("session-2").map(({ id }) => id)).toEqual(["three"])
    expect(selected).toHaveBeenCalledTimes(2)
    expect(other).toHaveBeenCalledTimes(1)
    // An unchanged Session keeps its snapshot.
    expect(approvals.list("session-1")).toBe(approvals.list("session-1"))
    expect(approvals.list("session-3")).toBe(approvals.list("session-3"))

    unsubscribe()
    emit(permission({ requestId: "four" }).pending)
    expect(selected).toHaveBeenCalledTimes(2)
  })
})
