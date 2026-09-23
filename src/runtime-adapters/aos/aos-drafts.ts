import { ExportedMessageRepository } from "@assistant-ui/core"
import type { AssistantRuntime } from "@assistant-ui/react"

/**
 * Keeps an AOS-only association between Assistant UI's optimistic local id
 * and the Agent chosen before a remote Session exists.
 */
export class AosDraftRegistry {
  readonly #agents = new Map<string, string>()
  readonly #listeners = new Set<() => void>()

  #notify() {
    this.#listeners.forEach((listener) => listener())
  }

  record(localId: string, agentId: string) {
    this.#agents.set(localId, agentId)
    this.#notify()
  }

  agentFor(localId: string) {
    return this.#agents.get(localId)
  }

  discard(localId: string) {
    if (this.#agents.delete(localId)) this.#notify()
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}

type DraftRuntime = Pick<AssistantRuntime, "threads">

const transitions = new WeakMap<DraftRuntime, Promise<unknown>>()

/** Creates a local Assistant UI thread and records its owning Agent. */
export async function createAosSessionDraft(
  runtime: DraftRuntime,
  registry: AosDraftRegistry,
  agentId: string
) {
  const previous = transitions.get(runtime) ?? Promise.resolve()
  const transition = previous
    .catch(() => undefined)
    .then(async () => {
      await runtime.threads.switchToNewThread()
      const state = runtime.threads.getState()
      const item = state.threadItems[state.mainThreadId]
      if (!item || item.remoteId || item.externalId)
        throw new Error("AOS draft did not create a local thread")
      const thread = runtime.threads.getById(state.mainThreadId)
      // Assistant UI can hand back a draft slot that still holds a refused
      // turn. `reset` writes through `setMessages`, which the ACP store leaves
      // out, so the slot is emptied through the store's import instead.
      thread.import(ExportedMessageRepository.fromArray([]))
      await thread.composer.reset()
      registry.record(state.mainThreadId, agentId)
      return state.mainThreadId
    })
  transitions.set(runtime, transition)
  try {
    return await transition
  } finally {
    if (transitions.get(runtime) === transition) transitions.delete(runtime)
  }
}
