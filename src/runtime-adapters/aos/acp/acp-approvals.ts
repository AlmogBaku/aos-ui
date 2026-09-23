import type { RequestPermissionRequest } from "@agentclientprotocol/sdk/experimental/v2"

import {
  AOS_META_KEY,
  AOS_PERMISSION_KIND_SESSION,
  AosPermissionMetaSchema,
} from "@aos/protocol/acp"

import type { AcpConnection, AcpPendingRequest } from "./types"

/**
 * Keeps ACP's `session/request_permission` requests as Assistant UI tool
 * approvals, answered on the card of the tool call they guard. The store lives
 * as long as the connection: the proxy sends an open request once, so a thread
 * that remounts reads what is still pending here rather than on the wire.
 *
 * Every UI with the Session open receives the same request. When another UI
 * answers it, or Stop ends the wait, the proxy withdraws this UI's copy with
 * `$/cancel_request`, which aborts the request's own signal. A withdrawn
 * request that guards a tool call leaves it, since the tool may still run; one
 * that stands alone reads as cancelled. The chosen option stays for as long as
 * the tab does; after a reload the tool's own result says what happened.
 */

export type AcpApprovalOption = {
  readonly id: string
  readonly kind: string
  /** Only a kind the card cannot name keeps the provider's own wording. */
  readonly label?: string
}

export type AcpApproval = {
  readonly id: string
  /** The tool call the request guards, when the proxy knows it. */
  readonly toolCallId?: string
  /** The operation asked for, which is the request's title. */
  readonly action: string
  /** Why it is asked, when the provider says more than the operation. */
  readonly description?: string
  readonly options: readonly AcpApprovalOption[]
  readonly expiresAt?: number
  readonly optionId?: string
  readonly approved?: boolean
  readonly resolution?: "cancelled" | "expired"
}

export type AcpApprovals = {
  list(sessionId: string): readonly AcpApproval[]
  subscribe(sessionId: string, listener: () => void): () => void
  respond(
    sessionId: string,
    approvalId: string,
    optionId: string,
    approved: boolean
  ): Promise<void>
}

type PermissionRequest = Extract<AcpPendingRequest, { kind: "permission" }>

type Entry = {
  approval: AcpApproval
  pending: PermissionRequest
  expiry?: ReturnType<typeof setTimeout>
}

/** ACP's standard kinds, in Assistant UI's spelling; AOS's pass through. */
const STANDARD_KINDS: Readonly<Record<string, string>> = {
  allow_once: "allow-once",
  allow_always: "allow-always",
  reject_once: "reject-once",
  reject_always: "reject-always",
}

const EMPTY: readonly AcpApproval[] = Object.freeze([])

function optionsOf(request: RequestPermissionRequest): AcpApprovalOption[] {
  return request.options.map(({ optionId, name, kind }) => {
    const standard = STANDARD_KINDS[kind]
    if (standard !== undefined) return { id: optionId, kind: standard }
    return kind === AOS_PERMISSION_KIND_SESSION
      ? { id: optionId, kind }
      : { id: optionId, kind, label: name }
  })
}

function guardedToolCallId(request: RequestPermissionRequest) {
  const { subject } = request
  if (subject?.type !== "tool_call") return undefined
  const { toolCall } = subject as { toolCall?: { toolCallId?: unknown } }
  return typeof toolCall?.toolCallId === "string"
    ? toolCall.toolCallId
    : undefined
}

/** Whether the request was answered, cancelled, or expired. */
export const isSettledApproval = (approval: AcpApproval) =>
  approval.optionId !== undefined || approval.resolution !== undefined

/** `setTimeout` fires at once past this; the proxy withdraws such a request. */
const MAX_TIMER_DELAY = 2 ** 31 - 1

export function createAcpApprovals({
  connection,
}: {
  connection: Pick<AcpConnection, "onPendingRequest">
}): AcpApprovals {
  const sessions = new Map<string, Map<string, Entry>>()
  const snapshots = new Map<string, readonly AcpApproval[]>()
  const listeners = new Map<string, Set<() => void>>()
  let generated = 0

  function changed(sessionId: string) {
    const entries = sessions.get(sessionId)
    snapshots.set(
      sessionId,
      entries ? [...entries.values()].map((entry) => entry.approval) : EMPTY
    )
    listeners.get(sessionId)?.forEach((listener) => listener())
  }

  function settle(
    sessionId: string,
    entry: Entry,
    patch: Partial<AcpApproval>
  ) {
    clearTimeout(entry.expiry)
    entry.expiry = undefined
    entry.approval = { ...entry.approval, ...patch }
    changed(sessionId)
  }

  function remove(sessionId: string, entry: Entry) {
    clearTimeout(entry.expiry)
    sessions.get(sessionId)?.delete(entry.approval.id)
    changed(sessionId)
  }

  connection.onPendingRequest((pending) => {
    if (pending.kind !== "permission") return
    const { sessionId, request } = pending
    const meta = AosPermissionMetaSchema.safeParse(
      request._meta?.[AOS_META_KEY]
    )
    const aos = meta.success ? meta.data : undefined
    const toolCallId = guardedToolCallId(request)
    const expiresAt =
      aos?.expiresAt === undefined ? undefined : Date.parse(aos.expiresAt)
    const description = request.description ?? aos?.message
    const approval: AcpApproval = {
      id: aos?.requestId ?? `acp-permission-${++generated}`,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      action: request.title,
      ...(description === undefined || description === request.title
        ? {}
        : { description }),
      options: optionsOf(request),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }
    const entries = sessions.get(sessionId) ?? new Map<string, Entry>()
    sessions.set(sessionId, entries)
    // A request re-issued under the same id, after a reconnect, replaces it.
    clearTimeout(entries.get(approval.id)?.expiry)
    const entry: Entry = { approval, pending }
    entries.set(approval.id, entry)
    const delay = expiresAt === undefined ? undefined : expiresAt - Date.now()
    if (delay !== undefined && delay <= MAX_TIMER_DELAY)
      entry.expiry = setTimeout(
        () => settle(sessionId, entry, { resolution: "expired" }),
        Math.max(0, delay)
      )
    changed(sessionId)

    pending.signal.addEventListener(
      "abort",
      () => {
        // A copy a re-issue replaced, or one already answered, stays as it is.
        if (entries.get(approval.id) !== entry) return
        if (entry.approval.optionId !== undefined) return
        if (approval.toolCallId !== undefined) remove(sessionId, entry)
        else if (entry.approval.resolution === undefined)
          settle(sessionId, entry, { resolution: "cancelled" })
      },
      { once: true }
    )
  })

  return {
    list(sessionId) {
      return snapshots.get(sessionId) ?? EMPTY
    },

    subscribe(sessionId, listener) {
      const existing = listeners.get(sessionId) ?? new Set<() => void>()
      existing.add(listener)
      listeners.set(sessionId, existing)
      return () => {
        existing.delete(listener)
        if (existing.size === 0) listeners.delete(sessionId)
      }
    },

    async respond(sessionId, approvalId, optionId, approved) {
      const entry = sessions.get(sessionId)?.get(approvalId)
      if (!entry || isSettledApproval(entry.approval))
        throw new Error(`Permission request "${approvalId}" is not pending`)
      if (!entry.approval.options.some(({ id }) => id === optionId))
        throw new Error(`Permission request has no option "${optionId}"`)
      entry.pending.respond({ outcome: { outcome: "selected", optionId } })
      settle(sessionId, entry, { optionId, approved })
    },
  }
}
