import type { AbstractAgent } from "@ag-ui/client"
import type { AssistantRuntime, MessageStatus } from "@assistant-ui/react"

import { createBrowserId } from "@/lib/browser-id"

import type { WorkspaceActivityEvent } from "../contracts"

type ActivityListener = {
  listener: (event: WorkspaceActivityEvent) => void
  onError?: (error: Error) => void
}

type ActiveOwner = Pick<AbstractAgent, "agentId" | "threadId">

type ActiveLifecycle = {
  agentId: string
  threadId: string
  lifecycleId: string
}

type ActiveSnapshot = {
  agentId?: string
  threadId?: string
  isRunning: boolean
}

export type AgUiActivityPublisherOptions = {
  clock?: () => Date
  activityIdFactory?: () => string
}

function activeRunId(runtime: AssistantRuntime, fallback: () => string) {
  const message = [...runtime.thread.getState().messages]
    .reverse()
    .find(
      ({ role, status }) => role === "assistant" && status?.type === "running"
    )
  return message?.id || fallback()
}

function terminalType(
  runtime: AssistantRuntime
): "run-finished" | "run-failed" | undefined {
  const status = [...runtime.thread.getState().messages]
    .reverse()
    .find(({ role }) => role === "assistant")?.status as
    MessageStatus | undefined
  if (status?.type === "complete") return "run-finished"
  if (status?.type === "incomplete" && status.reason === "error") {
    return "run-failed"
  }
  return undefined
}

function ownerSnapshot(
  runtime: AssistantRuntime,
  owner: ActiveOwner
): ActiveSnapshot {
  const agentId =
    typeof owner.agentId === "string" && owner.agentId.length > 0
      ? owner.agentId
      : undefined
  const threadId =
    typeof owner.threadId === "string" && owner.threadId.length > 0
      ? owner.threadId
      : undefined
  return {
    ...(agentId ? { agentId } : {}),
    ...(threadId ? { threadId } : {}),
    isRunning: runtime.thread.getState().isRunning,
  }
}

/**
 * Projects only the selected AG-UI runtime's observable run state. Generic
 * AG-UI exposes neither workspace-wide background runs nor authoritative
 * question, permission, or Agent-activation events, so this publisher does
 * not synthesize those categories.
 */
export class AgUiActivityPublisher {
  readonly #clock: () => Date
  readonly #activityIdFactory: () => string
  readonly #listeners = new Set<ActivityListener>()
  #runtime?: AssistantRuntime
  #owner?: ActiveOwner
  #stopRuntime?: () => void
  #snapshot?: ActiveSnapshot
  #active?: ActiveLifecycle

  constructor({
    clock = () => new Date(),
    activityIdFactory = createBrowserId,
  }: AgUiActivityPublisherOptions = {}) {
    this.#clock = clock
    this.#activityIdFactory = activityIdFactory
  }

  subscribe(
    listener: (event: WorkspaceActivityEvent) => void,
    onError?: (error: Error) => void
  ) {
    const entry = { listener, ...(onError ? { onError } : {}) }
    this.#listeners.add(entry)
    if (this.#listeners.size === 1) this.#startObservation()
    return () => {
      if (!this.#listeners.delete(entry)) return
      if (this.#listeners.size === 0) this.#stopObservation()
    }
  }

  attach(runtime: AssistantRuntime, owner: ActiveOwner) {
    this.#stopObservation()
    this.#runtime = runtime
    this.#owner = owner
    if (this.#listeners.size > 0) this.#startObservation()
  }

  detach() {
    this.#stopObservation()
    this.#runtime = undefined
    this.#owner = undefined
  }

  #startObservation() {
    if (this.#stopRuntime || !this.#runtime || !this.#owner) return
    try {
      this.#snapshot = ownerSnapshot(this.#runtime, this.#owner)
      this.#stopRuntime = this.#runtime.thread.subscribe(() => this.#observe())
    } catch (reason) {
      this.#publishError(reason)
      this.#stopObservation()
    }
  }

  #stopObservation() {
    this.#stopRuntime?.()
    this.#stopRuntime = undefined
    this.#snapshot = undefined
    this.#active = undefined
  }

  #observe() {
    if (!this.#runtime || !this.#owner) return
    let next: ActiveSnapshot
    try {
      next = ownerSnapshot(this.#runtime, this.#owner)
    } catch (reason) {
      this.#publishError(reason)
      return
    }
    const previous = this.#snapshot
    this.#snapshot = next
    if (!previous) return

    const sameOwner =
      previous.agentId === next.agentId && previous.threadId === next.threadId
    if (!sameOwner) {
      this.#active = undefined
      return
    }
    if (!next.agentId || !next.threadId) {
      this.#active = undefined
      return
    }

    if (!previous.isRunning && next.isRunning) {
      const runId = activeRunId(this.#runtime, this.#activityIdFactory)
      const lifecycleId = `ag-ui:run:${encodeURIComponent(next.threadId)}:${encodeURIComponent(runId)}`
      this.#active = {
        agentId: next.agentId,
        threadId: next.threadId,
        lifecycleId,
      }
      this.#publish({
        id: `${lifecycleId}:started`,
        agentId: next.agentId,
        threadId: next.threadId,
        occurredAt: this.#clock().toISOString(),
        type: "run-started",
        lifecycleId,
      })
      return
    }

    if (!previous.isRunning || next.isRunning) return
    const active = this.#active
    this.#active = undefined
    if (
      !active ||
      active.agentId !== next.agentId ||
      active.threadId !== next.threadId
    ) {
      return
    }
    const type = terminalType(this.#runtime)
    if (!type) return
    const terminal = type === "run-finished" ? "finished" : "failed"
    this.#publish({
      id: `${active.lifecycleId}:${terminal}`,
      agentId: active.agentId,
      threadId: active.threadId,
      occurredAt: this.#clock().toISOString(),
      type,
      lifecycleId: active.lifecycleId,
    })
  }

  #publish(event: WorkspaceActivityEvent) {
    for (const entry of this.#listeners) {
      try {
        entry.listener(structuredClone(event))
      } catch (reason) {
        this.#notifyError(entry, reason)
      }
    }
  }

  #publishError(reason: unknown) {
    for (const entry of this.#listeners) this.#notifyError(entry, reason)
  }

  #notifyError(entry: ActivityListener, reason: unknown) {
    try {
      entry.onError?.(
        reason instanceof Error ? reason : new Error(String(reason))
      )
    } catch {
      // One consumer cannot poison the active runtime observer.
    }
  }
}

export function createAgUiActivityPublisher(
  options?: AgUiActivityPublisherOptions
) {
  return new AgUiActivityPublisher(options)
}
