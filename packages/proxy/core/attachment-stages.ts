import { randomUUID } from "node:crypto"

import type { ServerAttachmentStage, ServerAttachmentStages } from "./runtime"

type Entry = {
  agentId: string
  sessionId: string
  stage: ServerAttachmentStage
}

/** Bounded one-shot registry; native references remain only inside closures. */
export class AttachmentStageRegistry implements ServerAttachmentStages {
  readonly #entries = new Map<string, Entry>()

  constructor(private readonly maximum = 256) {}

  create(agentId: string, sessionId: string, stage: ServerAttachmentStage) {
    if (this.#entries.size >= this.maximum) return undefined
    const stageId = `aos-stage-${randomUUID()}`
    this.#entries.set(stageId, { agentId, sessionId, stage })
    return stageId
  }

  take(agentId: string, sessionId: string, stageId: string) {
    const entry = this.#entries.get(stageId)
    if (!entry || entry.agentId !== agentId || entry.sessionId !== sessionId)
      return undefined
    this.#entries.delete(stageId)
    return entry.stage
  }
}
