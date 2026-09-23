"use client"

import { ChevronDown, LoaderCircle } from "lucide-react"
import { useThreadListLoadMore } from "@assistant-ui/core/react"
import { useAuiState } from "@assistant-ui/react"
import { cn } from "@/lib/utils"

import styles from "./agent-session-history.module.css"
import { useLoadMoreSentinel } from "./use-load-more-sentinel"

export type SessionHistoryLoadMoreCopy = {
  loadMoreSessions: string
  loadingMoreSessions: string
}

/**
 * Reads the thread list's next catalog page when the end of History scrolls
 * into view, and offers the same read as a button for keyboard and assistive
 * technology users. It renders nothing once the catalog has no more pages.
 */
export function SessionHistoryLoadMore({
  copy,
}: {
  copy: SessionHistoryLoadMoreCopy
}) {
  const { loadMore, disabled } = useThreadListLoadMore()
  const hasMore = useAuiState((state) => state.threads.hasMore)
  const loadingMore = useAuiState((state) => state.threads.isLoadingMore)
  const listed = useAuiState(
    (state) =>
      state.threads.threadIds.length + state.threads.archivedThreadIds.length
  )
  // Keep reading while the end stays in view, but only after a page that
  // listed more: a failed read waits for the button instead of looping.
  const sentinel = useLoadMoreSentinel({
    load: loadMore,
    disabled,
    loadKey: listed,
  })

  if (!hasMore) return null

  // Quiet centered text in both states, so the label changes in place and
  // focus stays on the control while the page loads.
  return (
    <div ref={sentinel} className="flex justify-center py-2">
      <button
        type="button"
        className={cn(
          styles.loadMore,
          "inline-flex items-center gap-1.5 px-2 py-1 text-xs"
        )}
        aria-disabled={loadingMore}
        onClick={loadingMore ? undefined : loadMore}
      >
        {loadingMore ? (
          <LoaderCircle
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        {loadingMore ? copy.loadingMoreSessions : copy.loadMoreSessions}
      </button>
      <p role="status" className="sr-only">
        {loadingMore ? copy.loadingMoreSessions : null}
      </p>
    </div>
  )
}
