"use client"

import { createContext, useContext, type ReactNode } from "react"
import { useAuiState } from "@assistant-ui/react"

import type { RuntimeInteractionAdapter } from "@/runtime-adapters/contracts"
import { useHasPendingInteraction } from "./use-has-pending-interaction"

/**
 * The selected runtime's interaction adapter, published to the Thread so its
 * run-changing affordances can gate on a request awaiting the operator without
 * knowing which runtime raised it. Runtimes that ask nothing provide none.
 */
const PendingInteractionContext = createContext<
  RuntimeInteractionAdapter | undefined
>(undefined)

export function PendingInteractionProvider({
  interactions,
  children,
}: {
  interactions?: RuntimeInteractionAdapter
  children: ReactNode
}) {
  return (
    <PendingInteractionContext.Provider value={interactions}>
      {children}
    </PendingInteractionContext.Provider>
  )
}

/**
 * Whether the selected runtime raises its questions out of band, so a question
 * tool call is a transcript record the operator answers beside the composer
 * rather than an answerable form of its own.
 */
export function useOutOfBandQuestions(): boolean {
  return useContext(PendingInteractionContext) !== undefined
}

/** Whether the mounted thread is waiting on the operator's answer. */
export function usePendingInteractionGate(): boolean {
  const interactions = useContext(PendingInteractionContext)
  const threadId = useAuiState(
    (state) => state.threadListItem.remoteId ?? state.threadListItem.id
  )
  return useHasPendingInteraction(interactions, threadId)
}
