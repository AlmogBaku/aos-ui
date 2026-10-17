"use client"

import { createContext, useContext } from "react"

import type { Dictionary } from "@/lib/i18n/dictionary"
import type { SideQuestion } from "@/runtime-adapters/contracts"

export type SideQuestionEntry = {
  readonly id: string
  /** The Agent and Session the question was asked about. */
  readonly agentId: string
  readonly sessionId: string
  readonly question: string
  readonly askedAt: number
  /** When the answer settled, which stops its timer. */
  readonly endedAt?: number
  readonly handle: SideQuestion
}

const settled = (handle: SideQuestion) => {
  const { state } = handle.snapshot()
  return state === "answered" || state === "failed"
}

/**
 * This tab's side questions, newest first. They live in memory alone: a reload
 * forgets them and leaves each fork archived where it is.
 */
export class SideQuestionStore {
  #entries: readonly SideQuestionEntry[] = []
  #asked = 0
  #quiet: ReadonlySet<string> = new Set()
  readonly #unfollow = new Map<string, () => void>()
  readonly #listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  readonly entries = () => this.#entries

  /**
   * The forks this tab asked in and did not keep, dismissed ones too: never
   * alerted, and never listed, so no Activity row opens a deleted fork.
   */
  readonly quietSessionIds = () => this.#quiet

  ask(
    handle: SideQuestion,
    question: Pick<SideQuestionEntry, "agentId" | "sessionId" | "question">
  ) {
    const entry: SideQuestionEntry = {
      ...question,
      id: String((this.#asked += 1)),
      askedAt: Date.now(),
      handle,
    }
    this.#entries = [entry, ...this.#entries]
    this.#unfollow.set(
      entry.id,
      handle.subscribe(() => this.#follow(entry.id, handle))
    )
    this.#follow(entry.id, handle)
    this.#emit()
  }

  /** Removes the row and deletes its fork. */
  dismiss(id: string) {
    const entry = this.#entries.find((candidate) => candidate.id === id)
    if (!entry) return Promise.resolve()
    this.#unfollowEntry(id)
    this.#replace(id, undefined)
    return entry.handle.dismiss()
  }

  /** Keeps the fork as an ordinary Session and removes the row. */
  async keep(id: string) {
    const entry = this.#entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error("This side question is closed.")
    const { sessionId } = await entry.handle.keep()
    this.#unfollowEntry(id)
    this.#quiet = new Set([...this.#quiet].filter((fork) => fork !== sessionId))
    this.#replace(id, undefined)
    return { agentId: entry.agentId, sessionId }
  }

  #unfollowEntry(id: string) {
    this.#unfollow.get(id)?.()
    this.#unfollow.delete(id)
  }

  #follow(id: string, handle: SideQuestion) {
    const fork = handle.snapshot().sessionId
    const learned = fork !== undefined && !this.#quiet.has(fork)
    if (learned) this.#quiet = new Set([...this.#quiet, fork])
    const entry = this.#entries.find((candidate) => candidate.id === id)
    if (entry && entry.endedAt === undefined && settled(handle))
      this.#replace(id, { ...entry, endedAt: Date.now() })
    else if (learned) this.#emit()
  }

  #replace(id: string, next: SideQuestionEntry | undefined) {
    this.#entries = this.#entries.flatMap((entry) =>
      entry.id !== id ? [entry] : next ? [next] : []
    )
    this.#emit()
  }

  #emit() {
    for (const listener of this.#listeners) listener()
  }
}

/** What the tray acts through, from the workspace that owns the store. */
export type SideQuestionWorkspace = {
  readonly store: SideQuestionStore
  readonly dictionary: Dictionary
  readonly openSession: (sessionId: string, agentId: string) => Promise<void>
  readonly reportError: (error: unknown) => void
}

export const SideQuestionContext = createContext<SideQuestionWorkspace | null>(
  null
)

export const useSideQuestions = () => useContext(SideQuestionContext)
