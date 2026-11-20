import { ExportedMessageRepository } from "@assistant-ui/core"
import type { AssistantRuntime } from "@assistant-ui/react"
import { SILENT_LOGGER, type Logger } from "@harness-gw/sdk"

/** How a draft's backing Session is made, held, and ended. */
export type DraftSessionHost = {
  create(agentId: string): Promise<{ sessionId: string }>
  /**
   * Holds the Session, so it outlives the client's grace, until the returned
   * release; `gone` hears that its provider no longer has it.
   */
  hold(sessionId: string, gone: () => void): () => void
  /** Ends a Session nothing will prompt. */
  close(sessionId: string): void
}

/** The Session created for one draft as it opened. */
type Backing = {
  readonly agentId: string
  /** The Session, or undefined once its create has failed. */
  readonly session: Promise<string | undefined>
  sessionId?: string
  failed: boolean
  release?: () => void
  /** The draft's first message took the Session, so its thread owns it. */
  claimed: boolean
  /** Let go of: a Session its create answers with afterwards is not held. */
  dropped: boolean
  /** Sessions this opening of the draft has already lost and replaced. */
  replaced: number
}

/** A draft recreates its backing Session at most this often per opening. */
const MAX_REPLACEMENTS = 1

/**
 * Keeps an AOS-only association between Assistant UI's optimistic local id
 * and the Agent chosen before a remote Session exists. Given a host, it also
 * creates the draft's Session as the draft opens, so the composer can read its
 * models and commands before the first message, and holds it while the draft
 * is on screen. Assistant UI keeps one new thread at a time and hands its id
 * out again, so a local id can name successive drafts.
 */
export class AosDraftRegistry {
  readonly #agents = new Map<string, string>()
  readonly #backings = new Map<string, Backing>()
  readonly #listeners = new Set<() => void>()
  readonly #host: DraftSessionHost | undefined
  readonly #logger: Pick<Logger, "warn">

  constructor(
    host?: DraftSessionHost,
    logger: Pick<Logger, "warn"> = SILENT_LOGGER
  ) {
    this.#host = host
    this.#logger = logger
  }

  #notify() {
    this.#listeners.forEach((listener) => listener())
  }

  record(localId: string, agentId: string) {
    this.#agents.set(localId, agentId)
    const backing = this.#backings.get(localId)
    // One empty draft per Agent: opening it again keeps the Session it has.
    const kept =
      backing?.agentId === agentId && !backing.claimed && !backing.failed
    if (!kept) {
      if (backing) this.#drop(localId, backing)
      this.#back(localId, agentId)
    }
    this.#notify()
  }

  agentFor(localId: string) {
    return this.#agents.get(localId)
  }

  /** The draft's backing Session, once its create has answered. */
  sessionFor(localId: string) {
    return this.#backings.get(localId)?.sessionId
  }

  /**
   * Hands the draft's backing Session to its first message, waiting out a
   * create still in flight; undefined when the draft has none to give.
   */
  claim(localId: string): Promise<string | undefined> {
    const backing = this.#backings.get(localId)
    if (!backing) return Promise.resolve(undefined)
    backing.claimed = true
    return backing.session
  }

  /**
   * Keeps only the backing Session of the thread on screen. Leaving an unsent
   * draft ends its Session, so a pick made on it is lost on return; a sent
   * draft's Session is its thread's, and is only let go of.
   */
  follow(mainThreadId: string) {
    const left = [...this.#backings].filter(([id]) => id !== mainThreadId)
    for (const [localId, backing] of left) this.#drop(localId, backing)
    if (left.length > 0) this.#notify()
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #back(localId: string, agentId: string, replaced = 0) {
    const host = this.#host
    if (!host) return
    const backing: Backing = {
      agentId,
      failed: false,
      claimed: false,
      dropped: false,
      replaced,
      session: host.create(agentId).then(
        ({ sessionId }) => {
          if (backing.dropped) {
            if (backing.claimed) return sessionId
            host.close(sessionId)
            return undefined
          }
          backing.sessionId = sessionId
          backing.release = host.hold(sessionId, () =>
            this.#lost(localId, backing)
          )
          this.#notify()
          return sessionId
        },
        (err: unknown) => {
          // The draft works as it did before it had one: its first message
          // creates the Session.
          this.#logger.warn({ err, agentId }, "draft.session_create_failed")
          backing.failed = true
          return undefined
        }
      ),
    }
    this.#backings.set(localId, backing)
  }

  /**
   * The provider lost an unsent draft's Session, so the draft gets another,
   * once; a second loss ends it as a draft whose create failed. A sent
   * draft's thread reports the loss itself.
   */
  #lost(localId: string, backing: Backing) {
    if (backing.claimed || this.#backings.get(localId) !== backing) return
    // Nothing is left to close.
    backing.sessionId = undefined
    this.#drop(localId, backing)
    if (backing.replaced < MAX_REPLACEMENTS) {
      this.#back(localId, backing.agentId, backing.replaced + 1)
    } else {
      this.#logger.warn(
        { agentId: backing.agentId },
        "draft.session_replacement_gave_up"
      )
      this.#backings.set(localId, {
        ...backing,
        session: Promise.resolve(undefined),
        failed: true,
        dropped: false,
        release: undefined,
      })
    }
    this.#notify()
  }

  /** Forgets a backing Session, ending it unless a first message took it. */
  #drop(localId: string, backing: Backing) {
    this.#backings.delete(localId)
    backing.dropped = true
    // Closing first forgets the Session, so the release parts nothing.
    if (!backing.claimed && backing.sessionId !== undefined)
      this.#host?.close(backing.sessionId)
    backing.release?.()
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
