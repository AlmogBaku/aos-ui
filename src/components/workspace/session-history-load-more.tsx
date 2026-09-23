"use client"

import { useThreadListLoadMore } from "@assistant-ui/core/react"
import { useAuiState } from "@assistant-ui/react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"

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
  const sentinel = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
  // The row count the last automatic read started from.
  const readFrom = useRef<number | null>(null)

  useEffect(() => {
    const node = sentinel.current
    if (!node || typeof IntersectionObserver !== "function") return
    const observer = new IntersectionObserver(([entry]) =>
      setInView(entry?.isIntersecting === true)
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore])

  useEffect(() => {
    if (!inView) {
      readFrom.current = null
      return
    }
    // Keep reading while the end stays in view, but only after a page that
    // listed more: a failed read waits for the button instead of looping.
    if (disabled || readFrom.current === listed) return
    readFrom.current = listed
    loadMore()
  }, [disabled, inView, listed, loadMore])

  if (!hasMore) return null

  return (
    <div ref={sentinel} className="flex justify-center p-2">
      <p role="status" className="text-sm text-muted-foreground">
        {loadingMore ? copy.loadingMoreSessions : null}
      </p>
      {loadingMore ? null : (
        <Button type="button" variant="ghost" size="sm" onClick={loadMore}>
          {copy.loadMoreSessions}
        </Button>
      )}
    </div>
  )
}
