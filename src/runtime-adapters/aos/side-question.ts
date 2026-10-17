import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import type { AcpConnection } from "@harness-gw/sdk"

import { sameData } from "@/lib/utils"
import type {
  SideQuestion,
  SideQuestionSnapshot,
} from "@/runtime-adapters/contracts"

import type { ProjectedMessage } from "./acp/projector-messages"
import {
  applyUpdate,
  initialProjectorState,
  type ProjectorState,
} from "./acp/session-projector"

/** How long Dismiss waits for a stopped turn to end before deleting its fork. */
const SETTLE_TIMEOUT_MS = 10_000

export type SideQuestionOptions = {
  connection: Pick<
    AcpConnection,
    | "forkSession"
    | "subscribe"
    | "updateSession"
    | "prompt"
    | "cancel"
    | "deleteSession"
  >
  markSessionRead?: ((sessionId: string) => Promise<void>) | undefined
  settleTimeoutMs?: number
}

const textOf = ({ parts }: ProjectedMessage) =>
  parts
    .map((part) =>
      part.source === "message" && part.block.type === "text"
        ? part.block.text
        : ""
    )
    .join("")

/** The last assistant text after the question, as it streams. */
function answerOf(messages: readonly ProjectedMessage[]) {
  const asked = messages.findLastIndex(({ role }) => role === "user")
  return messages
    .slice(asked + 1)
    .filter(({ role }) => role === "assistant")
    .map(textOf)
    .findLast((text) => text.length > 0)
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * One question in an archived fork of a Session. The fork's own updates fold
 * through the Session projector, and the turn's last assistant text is the
 * answer; the fork is deleted on Dismiss unless Continue kept it.
 */
class AcpSideQuestion implements SideQuestion {
  readonly #options: SideQuestionOptions
  readonly #listeners = new Set<() => void>()
  readonly #asked: Promise<void>
  #snapshot: SideQuestionSnapshot = { state: "asking" }
  #projection: ProjectorState = initialProjectorState
  #fork: string | undefined
  #leave: (() => void) | undefined
  #prompted = false
  #ran = false
  #settled = false
  #failure: string | undefined
  /** Dismissed or kept: no later call touches the fork. */
  #retired = false
  #onSettle: (() => void) | undefined

  constructor(options: SideQuestionOptions, sessionId: string, text: string) {
    this.#options = options
    this.#asked = this.#ask(sessionId, text)
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  snapshot() {
    return this.#snapshot
  }

  async #ask(sessionId: string, text: string) {
    const { connection } = this.#options
    try {
      const { sessionId: fork } = await connection.forkSession(sessionId)
      this.#fork = fork
      // Before any other await: the connection parts a fork nobody watches
      // once its grace ends.
      this.#leave = connection.subscribe(fork, {
        update: (update, meta) => this.#fold(update, meta),
      })
      this.#publish()
      // No tab or device lists the fork unless Continue keeps it.
      await connection.updateSession({ sessionId: fork, archived: true })
      if (this.#retired) return
      await connection.prompt(fork, [{ type: "text", text }], {
        clientId: crypto.randomUUID(),
      })
      this.#prompted = true
    } catch (error) {
      this.#failure = errorText(error)
      this.#publish()
    }
  }

  #fold(update: SessionUpdate, meta: unknown) {
    this.#projection = applyUpdate(this.#projection, update, meta)
    const { status } = this.#projection.execution
    if (status === "running" || status === "waiting-for-input") this.#ran = true
    else if (this.#ran && !this.#settled) this.#settle()
    this.#publish()
  }

  #settle() {
    this.#settled = true
    this.#onSettle?.()
    if (this.#retired || this.#fork === undefined) return
    this.#options.markSessionRead?.(this.#fork).catch(() => {
      // The fork is archived, so an unread mark there shows nowhere.
    })
  }

  #publish() {
    const answer = answerOf(this.#projection.messages)
    const { status, error } = this.#projection.execution
    const failed =
      this.#failure !== undefined ||
      (this.#settled && (status === "failed" || answer === undefined))
    const reason = this.#failure ?? error?.message
    const next: SideQuestionSnapshot = {
      state: failed
        ? "failed"
        : this.#settled
          ? "answered"
          : status === "waiting-for-input"
            ? "needs-input"
            : "asking",
      ...(answer === undefined ? {} : { answer }),
      ...(failed && reason ? { error: reason } : {}),
      ...(this.#fork === undefined ? {} : { sessionId: this.#fork }),
    }
    if (sameData(next, this.#snapshot)) return
    this.#snapshot = next
    for (const listener of this.#listeners) listener()
  }

  /** Settles once the fork's turn ends, or once the timeout passes. */
  #turnEnded() {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(
        resolve,
        this.#options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS
      )
      this.#onSettle = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  #release() {
    this.#leave?.()
    this.#leave = undefined
  }

  async dismiss() {
    if (this.#retired) return
    this.#retired = true
    await this.#asked
    const fork = this.#fork
    if (fork === undefined) return
    if (this.#prompted && !this.#settled) {
      const ended = this.#turnEnded()
      this.#options.connection.cancel(fork)
      await ended
    }
    this.#release()
    await this.#options.connection.deleteSession(fork)
  }

  async keep() {
    await this.#asked
    const fork = this.#fork
    if (this.#retired || fork === undefined)
      throw new Error(this.#failure ?? "This side question has no fork.")
    await this.#options.connection.updateSession({
      sessionId: fork,
      archived: false,
    })
    this.#retired = true
    this.#release()
    return { sessionId: fork }
  }
}

/** Asks side questions over one ACP connection whose gateway forks. */
export function createSideQuestions(options: SideQuestionOptions) {
  return (sessionId: string, question: string): SideQuestion =>
    new AcpSideQuestion(options, sessionId, question)
}
