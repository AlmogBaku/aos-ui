import { useCallback, useSyncExternalStore, type ReactNode } from "react"
import type { Locale } from "@/lib/i18n/config"
import type { RuntimeInteractionAdapter } from "@/runtime-adapters/contracts"
import { RuntimeQuestionComposer } from "./question-composer"

const noop = () => {}

/** Reads only the selected Session; provider subscriptions own reconciliation. */
export function PendingInteractionComposer({
  locale,
  sessionId,
  interactions,
  fallback,
}: {
  locale: Locale
  sessionId: string
  interactions: RuntimeInteractionAdapter
  fallback: ReactNode
}) {
  const subscribe = useCallback(
    (listener: () => void) => interactions.subscribe(sessionId, listener),
    [interactions, sessionId]
  )
  const getSnapshot = useCallback(
    () => interactions.getPending(sessionId),
    [interactions, sessionId]
  )
  const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!request || request.sessionId !== sessionId) return fallback
  const composer = (
    <RuntimeQuestionComposer
      key={`${sessionId}:${request.requestId}`}
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
