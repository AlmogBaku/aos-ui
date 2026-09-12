import { randomUUID } from "node:crypto"

import type { HermesPublicAttachment } from "./content"

export type HermesAttachmentStage = {
  public: readonly HermesPublicAttachment[]
  appendTo(text: string): string
  cleanup(): Promise<void>
}

type Entry = {
  agentId: string
  sessionId: string
  stage: HermesAttachmentStage
}

/** Bounded one-shot registry; native references remain only inside closures. */
export class HermesAttachmentStageRegistry {
  readonly #entries = new Map<string, Entry>()

  constructor(private readonly maximum = 256) {}

  create(agentId: string, sessionId: string, stage: HermesAttachmentStage) {
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
