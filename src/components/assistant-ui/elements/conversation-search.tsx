"use client"

import { Button } from "@/components/ui/button"
import { keyboardEventSafetyReason } from "@/lib/keyboard"
import type { LocaleDirection } from "@/lib/i18n/config"
import { Search, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"

export const CONVERSATION_SEARCH_EVENT = "aos:conversation-search"

const SEARCH_MATCH_HIGHLIGHT = "aos-conversation-search-match"
const SEARCH_ACTIVE_HIGHLIGHT = "aos-conversation-search-active"

type SearchableMessage = {
  readonly id: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

export type ConversationSearchLabels = {
  readonly search: string
  readonly placeholder: string
  readonly previous: string
  readonly next: string
  readonly close: string
  readonly results: (index: number, count: number) => string
}

export const DEFAULT_CONVERSATION_SEARCH_LABELS: ConversationSearchLabels = {
  search: "Search in conversation",
  placeholder: "Find in conversation…",
  previous: "Previous result",
  next: "Next result",
  close: "Close search",
  results: (index, count) => `${index} of ${count}`,
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function textRanges(root: Element, query: string) {
  const nodes: Array<{ node: Text; start: number; end: number }> = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ""
  let current = walker.nextNode()

  while (current) {
    const node = current as Text
    const start = text.length
    text += node.data
    nodes.push({ node, start, end: text.length })
    current = walker.nextNode()
  }

  const ranges: Range[] = []
  const matcher = new RegExp(escapeRegularExpression(query), "giu")
  for (const match of text.matchAll(matcher)) {
    const matchStart = match.index
    const matchEnd = matchStart + match[0].length
    const startNode = nodes.find(
      ({ start, end }) => start <= matchStart && matchStart < end
    )
    const endNode = nodes.find(
      ({ start, end }) => start < matchEnd && matchEnd <= end
    )
    if (!startNode || !endNode) continue

    const range = document.createRange()
    range.setStart(startNode.node, matchStart - startNode.start)
    range.setEnd(endNode.node, matchEnd - endNode.start)
    ranges.push(range)
  }
  return ranges
}

function searchableRanges(messageId: string, query: string) {
  const message = document.querySelector(
    `[data-message-id="${CSS.escape(messageId)}"]`
  )
  if (!message) return []

  return Array.from(
    message.querySelectorAll("[data-searchable-message-text]")
  ).flatMap((root) => textRanges(root, query))
}

function clearSearchHighlights() {
  if (!("highlights" in CSS)) return
  CSS.highlights.delete(SEARCH_MATCH_HIGHLIGHT)
  CSS.highlights.delete(SEARCH_ACTIVE_HIGHLIGHT)
}

function showSearchHighlights(
  occurrences: readonly Range[],
  activeOccurrence: Range | undefined
) {
  if (!("highlights" in CSS) || typeof Highlight === "undefined") return

  CSS.highlights.set(SEARCH_MATCH_HIGHLIGHT, new Highlight(...occurrences))
  CSS.highlights.set(
    SEARCH_ACTIVE_HIGHLIGHT,
    new Highlight(...(activeOccurrence ? [activeOccurrence] : []))
  )
}

function scrollableParent(element: Element) {
  let parent = element.parentElement
  while (parent) {
    const { overflowY } = getComputedStyle(parent)
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    ) {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

function occurrenceRect(occurrence: Range, element: Element) {
  return typeof occurrence.getBoundingClientRect === "function"
    ? occurrence.getBoundingClientRect()
    : element.getBoundingClientRect()
}

function setScrollTopImmediately(viewport: HTMLElement, scrollTop: number) {
  const previousScrollBehavior = viewport.style.scrollBehavior
  viewport.style.scrollBehavior = "auto"
  viewport.scrollTop = Math.max(0, scrollTop)
  viewport.style.scrollBehavior = previousScrollBehavior
}

function scrollOccurrenceIntoView(occurrence: Range) {
  const element = occurrence.startContainer.parentElement
  if (!element) return

  const viewport = scrollableParent(element)
  if (!viewport) {
    element.scrollIntoView?.({ block: "center", behavior: "auto" })
    return
  }

  const selectedRect = occurrenceRect(occurrence, element)
  const viewportRect = viewport.getBoundingClientRect()
  const centeredTop =
    viewport.scrollTop +
    selectedRect.top -
    viewportRect.top -
    (viewport.clientHeight - selectedRect.height) / 2
  setScrollTopImmediately(viewport, centeredTop)
}

/**
 * A registry-style, provider-neutral conversation search surface. Its caller
 * supplies the current Thread's loaded messages, so server history and other
 * branches never become searchable by accident.
 */
export function ConversationSearch({
  messages,
  labels = DEFAULT_CONVERSATION_SEARCH_LABELS,
  direction = "ltr",
}: {
  messages: readonly SearchableMessage[]
  labels?: ConversationSearchLabels
  direction?: LocaleDirection
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const restoreFramesRef = useRef<number[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const [occurrences, setOccurrences] = useState<readonly Range[]>([])

  const messageIds = useMemo(
    () => messages.map((message) => message.id),
    [messages]
  )

  const close = useCallback(() => {
    const activeOccurrence =
      occurrences[Math.min(index, occurrences.length - 1)]
    const anchor = activeOccurrence?.startContainer.parentElement
    const viewport = anchor ? scrollableParent(anchor) : null
    const anchorTop =
      activeOccurrence && anchor
        ? occurrenceRect(activeOccurrence, anchor).top
        : undefined

    setOpen(false)
    setQuery("")
    setIndex(0)
    const firstFrame = requestAnimationFrame(() => {
      if (activeOccurrence && anchor && viewport && anchorTop !== undefined) {
        const restore = () => {
          const currentTop = occurrenceRect(activeOccurrence, anchor).top
          setScrollTopImmediately(
            viewport,
            viewport.scrollTop + currentTop - anchorTop
          )
        }
        restore()
        restoreFramesRef.current.push(requestAnimationFrame(restore))
      }
      triggerRef.current?.focus({ preventScroll: true })
    })
    restoreFramesRef.current.push(firstFrame)
  }, [index, occurrences])

  const move = useCallback(
    (delta: 1 | -1) => {
      if (!occurrences.length) return
      setIndex(
        (current) => (current + delta + occurrences.length) % occurrences.length
      )
    },
    [occurrences.length]
  )

  useEffect(() => {
    const openSearch = () => {
      triggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      setQuery("")
      setIndex(0)
      setOpen(true)
    }
    window.addEventListener(CONVERSATION_SEARCH_EVENT, openSearch)
    return () =>
      window.removeEventListener(CONVERSATION_SEARCH_EVENT, openSearch)
  }, [])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(
    () => () => {
      restoreFramesRef.current.forEach(cancelAnimationFrame)
      restoreFramesRef.current = []
    },
    []
  )

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const needle = query.trim()
      setOccurrences(
        open && needle
          ? messageIds.flatMap((messageId) =>
              searchableRanges(messageId, needle)
            )
          : []
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [messageIds, messages, open, query])

  useEffect(() => {
    if (!occurrences.length) {
      clearSearchHighlights()
      return
    }

    const activeIndex = Math.min(index, occurrences.length - 1)
    const activeOccurrence = occurrences[activeIndex]
    showSearchHighlights(occurrences, activeOccurrence)
    if (activeOccurrence) scrollOccurrenceIntoView(activeOccurrence)
    return clearSearchHighlights
  }, [index, occurrences])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (keyboardEventSafetyReason(event)) return
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      move(-1)
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      move(1)
    } else if (event.key === "Enter" || event.key === "F3") {
      event.preventDefault()
      move(event.shiftKey ? -1 : 1)
    }
  }

  if (!open) return null
  const count = occurrences.length
  const activeIndex = Math.min(index, Math.max(count - 1, 0))
  return (
    <div
      role="search"
      aria-label={labels.search}
      dir={direction}
      className="sticky top-2 z-20 mx-auto flex w-full max-w-[45rem] items-center gap-2 rounded-xl border bg-background p-2 shadow-sm motion-reduce:transition-none"
    >
      <Search
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        aria-label={labels.search}
        className="min-w-0 flex-1 appearance-none border-0 bg-transparent px-1 py-1 text-sm shadow-none outline-none"
        placeholder={labels.placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        onKeyDown={onKeyDown}
      />
      <span
        aria-live="polite"
        className="shrink-0 text-xs text-muted-foreground"
      >
        {count ? labels.results(activeIndex + 1, count) : labels.results(0, 0)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={labels.previous}
        onClick={() => move(-1)}
        disabled={!count}
      >
        ↑
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={labels.next}
        onClick={() => move(1)}
        disabled={!count}
      >
        ↓
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={labels.close}
        onClick={close}
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  )
}
