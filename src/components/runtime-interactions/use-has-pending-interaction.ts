import { useCallback, useSyncExternalStore } from "react"

import type { RuntimeInteractionAdapter } from "@/runtime-adapters/contracts"

const unsubscribed = () => () => {}

/**
 * Whether the selected Session is waiting on the operator, so the Thread can
 * gate the composer and its send affordances without knowing which runtime
 * raised the request.
 */
export function useHasPendingInteraction(
  interactions: RuntimeInteractionAdapter | undefined,
  threadId: string | undefined
): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      interactions && threadId
        ? interactions.subscribe(threadId, listener)
        : unsubscribed(),
    [interactions, threadId]
  )
  const getSnapshot = useCallback(
    () =>
      interactions !== undefined &&
      threadId !== undefined &&
      interactions.getPending(threadId) !== undefined,
    [interactions, threadId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
