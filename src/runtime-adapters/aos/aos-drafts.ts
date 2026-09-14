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

const registries = new WeakMap<DraftRuntime, AosDraftRegistry>()
const transitions = new WeakMap<DraftRuntime, Promise<unknown>>()

export function registerAosDraftRegistry(
  runtime: DraftRuntime,
  registry: AosDraftRegistry
) {
  registries.set(runtime, registry)
  return () => {
    if (registries.get(runtime) === registry) registries.delete(runtime)
  }
}

/**
 * Creates a local Assistant UI thread and records its owning Agent. This does
 * not perform any network work; RemoteThreadListAdapter.initialize owns the
 * first remote write when a message is actually sent.
 */
export async function switchToAosDraft(runtime: DraftRuntime, agentId: string) {
  const registry = registries.get(runtime)
  if (!registry) return false
  const previous = transitions.get(runtime) ?? Promise.resolve()
  const transition = previous
    .catch(() => undefined)
    .then(async () => {
      await runtime.threads.switchToNewThread()
      const state = runtime.threads.getState()
      const item = state.threadItems[state.mainThreadId]
      if (!item || item.remoteId || item.externalId)
        throw new Error("AOS draft did not create a local thread")
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
