"use client"

import { Button } from "@/components/ui/button"
import { keyboardEventSafetyReason } from "@/lib/keyboard"
import type { LocaleDirection } from "@/lib/i18n/config"
import { Search, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent, RefObject } from "react"
import {
  isFoldedAt,
  turnLayout,
} from "@/components/assistant-ui/elements/turn-fold"

export const CONVERSATION_SEARCH_EVENT = "aos:conversation-search"

const SEARCH_MATCH_HIGHLIGHT = "aos-conversation-search-match"
const SEARCH_ACTIVE_HIGHLIGHT = "aos-conversation-search-active"

type SearchableMessage = {
  readonly id: string
  readonly role?: string
  readonly status?: { readonly type: string }
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

/** Centers a message whose rendered text holds no match to highlight. */
function scrollMessageIntoView(messageId: string) {
  document
    .querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    ?.scrollIntoView?.({ block: "center", behavior: "auto" })
}

/** Frames to wait for a virtualized thread to mount a message it scrolled to. */
const REVEAL_FRAMES = 10

const ALWAYS_MOUNTED = () => true

type SearchMatch = { readonly messageId: string; readonly ordinal: number }

/**
 * A cheap plain-text pass over Markdown, so matches count what renders rather
 * than its source: link targets, emphasis and inline-code markers, fence info
 * strings, and heading hashes are dropped. It is an approximation, not a
 * parser; the highlight still comes from the rendered text.
 */
export function markdownPlainText(markdown: string) {
  return markdown
    .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, "")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*+|~~/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
}

/**
 * The text a message shows while its folds are closed. A settled assistant
 * turn folds its mid-turn prose, and a closed fold renders none of it.
 */
function visibleText(message: SearchableMessage) {
  const layout =
    message.role === "assistant"
      ? turnLayout(message.content, message.status?.type)
      : undefined
  return message.content.flatMap((part, index) =>
    part.type === "text" && part.text && !(layout && isFoldedAt(layout, index))
      ? [markdownPlainText(part.text)]
      : []
  )
}

function messageMatches(
  messages: readonly SearchableMessage[],
  needle: string
): SearchMatch[] {
  const matcher = new RegExp(escapeRegularExpression(needle), "giu")
  return messages.flatMap((message) => {
    const count = visibleText(message).reduce(
      (total, text) => total + Array.from(text.matchAll(matcher)).length,
      0
    )
    return Array.from({ length: count }, (_, ordinal) => ({
      messageId: message.id,
      ordinal,
    }))
  })
}

/**
 * A registry-style, provider-neutral conversation search surface. Its caller
 * supplies the current Thread's loaded messages, so server history and other
 * branches never become searchable by accident.
 *
 * Matches come from the message data, not the page, because a virtualized
 * thread mounts only the messages near the viewport. Moving to a match asks
 * `revealMessage` to bring its message into the mounted window, then
 * highlights it; the other matches are highlighted wherever they are mounted.
 */
export function ConversationSearch({
  messages,
  labels = DEFAULT_CONVERSATION_SEARCH_LABELS,
  direction = "ltr",
  revealMessage = ALWAYS_MOUNTED,
  viewportRef,
}: {
  messages: readonly SearchableMessage[]
  labels?: ConversationSearchLabels
  direction?: LocaleDirection
  /** Returns true once the message is mounted; false while it scrolls in. */
  revealMessage?: (messageId: string) => boolean
  /** The scrolling thread, whose scroll mounts messages that may match. */
  viewportRef?: RefObject<HTMLElement | null>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const restoreFramesRef = useRef<number[]>([])
  const activeOccurrenceRef = useRef<Range | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)

  const needle = query.trim()
  const matches = useMemo(
    () => (open && needle ? messageMatches(messages, needle) : []),
    [messages, needle, open]
  )
  const count = matches.length
  const activeIndex = Math.min(index, Math.max(count - 1, 0))
  const activeMatch = matches[activeIndex]
  const activeMessageId = activeMatch?.messageId
  const activeOrdinal = activeMatch?.ordinal ?? 0

  /** Highlights every mounted match and returns the active one's range. */
  const paint = useCallback(() => {
    if (!matches.length) {
      clearSearchHighlights()
      activeOccurrenceRef.current = undefined
      return undefined
    }
    const messageIds = [...new Set(matches.map((match) => match.messageId))]
    const occurrences = messageIds.flatMap((messageId) =>
      searchableRanges(messageId, needle)
    )
    const activeRanges = activeMessageId
      ? searchableRanges(activeMessageId, needle)
      : []
    // The data and the page can disagree on a count; the nearest one stands in.
    const activeOccurrence =
      activeRanges[Math.min(activeOrdinal, activeRanges.length - 1)] ??
      activeRanges[0]
    showSearchHighlights(occurrences, activeOccurrence)
    activeOccurrenceRef.current = activeOccurrence
    return activeOccurrence
  }, [activeMessageId, activeOrdinal, matches, needle])

  const close = useCallback(() => {
    const activeOccurrence = activeOccurrenceRef.current
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
  }, [])

  const move = useCallback(
    (delta: 1 | -1) => {
      if (!count) return
      setIndex((current) => (current + delta + count) % count)
    },
    [count]
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

  // Moving to a match brings its message in, then centers the match.
  useEffect(() => {
    if (!activeMessageId) return
    let attempts = 0
    let frame: number | null = null
    const reveal = () => {
      frame = null
      if (!revealMessage(activeMessageId) && ++attempts < REVEAL_FRAMES) {
        frame = requestAnimationFrame(reveal)
        return
      }
      const activeOccurrence = paint()
      if (activeOccurrence) scrollOccurrenceIntoView(activeOccurrence)
      else scrollMessageIntoView(activeMessageId)
    }
    reveal()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
    // Only a different active match moves the thread; new matches repaint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMessageId, activeOrdinal, needle, revealMessage])

  // Matches in messages mounted later, by scrolling or streaming, light up too.
  useEffect(() => {
    let frame: number | null = null
    const repaint = () => {
      frame ??= requestAnimationFrame(() => {
        frame = null
        paint()
      })
    }
    repaint()
    const viewport = viewportRef?.current
    viewport?.addEventListener("scroll", repaint, { passive: true })
    return () => {
      viewport?.removeEventListener("scroll", repaint)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [paint, viewportRef])

  useEffect(() => clearSearchHighlights, [])

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
