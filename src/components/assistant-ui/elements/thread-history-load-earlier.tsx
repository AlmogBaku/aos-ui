"use client"

import { ChevronUp, LoaderCircle } from "lucide-react"
import { useAuiState } from "@assistant-ui/react"
import { useCallback, type RefObject } from "react"

import { Button } from "@/components/ui/button"
import { useLoadMoreSentinel } from "@/components/workspace/use-load-more-sentinel"
import { threadHistoryExtras } from "@/runtime-adapters/thread-history"

export type ThreadHistoryLoadEarlierLabels = {
  loadEarlierMessages: string
  loadingEarlierMessages: string
  conversationBeginning: string
  earlierMessagesUnavailable: string
}

/** One viewport above the top, so the next page is read before it is reached. */
const READ_AHEAD_MARGIN = "100% 0px 0px 0px"

/**
 * The thread's top row: reads the Session's older history as the top nears,
 * and offers the same read as a button for keyboard and assistive technology
 * users. Once nothing older can be read it marks the beginning, or says the
 * provider keeps turns no page reaches, at the same height. It renders nothing
 * until the runtime knows where the history stands, and nothing for a thread
 * with no messages yet.
 */
export function ThreadHistoryLoadEarlier({
  viewportRef,
  labels,
}: {
  viewportRef: RefObject<HTMLElement | null>
  labels: ThreadHistoryLoadEarlierLabels
}) {
  const history = threadHistoryExtras.use((extras) => extras.history, undefined)
  const messageCount = useAuiState((state) => state.thread.messages.length)
  const loadOlder = history?.loadOlder
  const load = useCallback(() => void loadOlder?.(), [loadOlder])
  const sentinel = useLoadMoreSentinel({
    load,
    // A failed read waits for the button instead of looping.
    disabled: !history?.hasOlder || history.loading || history.failed,
    loadKey: messageCount,
    root: viewportRef,
    rootMargin: READ_AHEAD_MARGIN,
  })

  if (!history || messageCount === 0) return null
  const { hasOlder, loading, truncated } = history

  return (
    <div
      ref={hasOlder ? sentinel : undefined}
      className="flex h-10 items-center justify-center"
    >
      {hasOlder ? (
        // Focus stays on the control while its label changes in place.
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          aria-disabled={loading}
          onClick={loading ? undefined : load}
        >
          {loading ? (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <ChevronUp aria-hidden="true" />
          )}
          {loading ? labels.loadingEarlierMessages : labels.loadEarlierMessages}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          {truncated
            ? labels.earlierMessagesUnavailable
            : labels.conversationBeginning}
        </p>
      )}
      <p role="status" className="sr-only">
        {loading ? labels.loadingEarlierMessages : null}
      </p>
    </div>
  )
}
