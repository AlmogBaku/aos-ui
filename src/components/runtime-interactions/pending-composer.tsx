import { useCallback, useSyncExternalStore, type ReactNode } from "react"
import type { Locale } from "@/lib/i18n/config"
import type { RuntimeInteractionAdapter } from "@/runtime-adapters/contracts"
import { RuntimeQuestionComposer } from "./question-composer"

const noop = () => {}

/** Reads only the selected Session; provider subscriptions own reconciliation. */
export function PendingInteractionComposer({
  locale,
  threadId,
  interactions,
  fallback,
}: {
  locale: Locale
  threadId: string
  interactions: RuntimeInteractionAdapter
  fallback: ReactNode
}) {
  const subscribe = useCallback(
    (listener: () => void) => interactions.subscribe(threadId, listener),
    [interactions, threadId]
  )
  const getSnapshot = useCallback(
    () => interactions.getPending(threadId),
    [interactions, threadId]
  )
  const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!request || request.sessionId !== threadId) return fallback
  return (
    <RuntimeQuestionComposer
      key={`${threadId}:${request.requestId}`}
      locale={locale}
      request={request}
      interactions={interactions}
      onDismissExpired={noop}
      onResponsePending={noop}
      onResolved={noop}
    />
  )
}
