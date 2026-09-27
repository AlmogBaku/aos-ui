import { randomUUID } from "node:crypto"

import type { ServerAttachmentStage, ServerAttachmentStages } from "./runtime"

type Entry = {
  agentId: string
  sessionId: string
  stage: ServerAttachmentStage
  sizeBytes: number
  timer: ReturnType<typeof setTimeout>
}

/** Staged attachment bytes one process holds at once. */
const MAXIMUM_STAGED_BYTES = 256 * 1024 * 1024

/**
 * The largest stage request body a route reads, and so the most bytes one
 * request stages.
 */
export const MAXIMUM_STAGE_REQUEST_BYTES = 35_500_000

/** Bounded, expiring one-shot registry; native references remain inside closures. */
export class AttachmentStageRegistry implements ServerAttachmentStages {
  readonly #entries = new Map<string, Entry>()
  #storedBytes = 0

  constructor(
    private readonly maximum = 256,
    private readonly ttlMs = 300_000,
    private readonly maximumBytes = MAXIMUM_STAGED_BYTES,
    private readonly maximumPerScope = maximum,
    private readonly maximumBytesPerScope = maximumBytes
  ) {}

  create(
    agentId: string,
    sessionId: string,
    stage: ServerAttachmentStage,
    sizeBytes = 0
  ) {
    const scoped = [...this.#entries.values()].filter(
      (entry) => entry.agentId === agentId && entry.sessionId === sessionId
    )
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      this.#entries.size >= this.maximum ||
      scoped.length >= this.maximumPerScope ||
      scoped.reduce((total, entry) => total + entry.sizeBytes, sizeBytes) >
        this.maximumBytesPerScope ||
      this.#storedBytes + sizeBytes > this.maximumBytes
    )
      return undefined
    const stageId = `aos-stage-${randomUUID()}`
    const timer = setTimeout(() => {
      const entry = this.#delete(stageId)
      if (entry) void entry.stage.cleanup().catch(() => undefined)
    }, this.ttlMs)
    if (typeof timer !== "number") timer.unref()
    this.#entries.set(stageId, { agentId, sessionId, stage, sizeBytes, timer })
    this.#storedBytes += sizeBytes
    return stageId
  }

  take(agentId: string, sessionId: string, stageId: string) {
    const entry = this.#entries.get(stageId)
    if (!entry || entry.agentId !== agentId || entry.sessionId !== sessionId)
      return undefined
    this.#delete(stageId)
    return entry.stage
  }

  #delete(stageId: string) {
    const entry = this.#entries.get(stageId)
    if (!entry) return undefined
    this.#entries.delete(stageId)
    clearTimeout(entry.timer)
    this.#storedBytes -= entry.sizeBytes
    return entry
  }
}
