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
  const composer = (
    <RuntimeQuestionComposer
      key={`${threadId}:${request.requestId}`}
      locale={locale}
      request={request}
      interactions={interactions}
      expired={request.status === "expired"}
      recovered={request.status === "recovered"}
      onDismissExpired={() => interactions.dismiss?.(request)}
      onResponsePending={noop}
      onResolved={noop}
    />
  )
  return request.status === "recovered" ? (
    <>
      <div className="mx-auto flex w-full max-w-2xl px-4 pb-3">{composer}</div>
      {fallback}
    </>
  ) : (
    composer
  )
}
