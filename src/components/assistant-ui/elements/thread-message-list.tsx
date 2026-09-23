"use client"

import { cn } from "@/lib/utils"
import {
  ThreadPrimitive,
  unstable_useThreadMessageIds,
} from "@assistant-ui/react"
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/react-virtual"
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type Ref,
  type RefObject,
} from "react"

import {
  captureThreadReadingBookmark,
  firstVisibleMessage,
  type ThreadReadingBookmark,
} from "./thread-reading-position"

/** A first guess only; every mounted message is measured as it renders. */
const ESTIMATED_MESSAGE_HEIGHT_PX = 160
/** Messages mounted beyond each edge of the viewport. */
const OVERSCAN = 6
/**
 * A Session this short mounts whole: the window would save nothing, and the
 * browser's own find and a screen reader's browse mode then reach every
 * message. It also keeps a layout-free renderer showing the whole thread.
 */
export const WHOLE_THREAD_MESSAGE_LIMIT = 30

type MessageComponents = ComponentProps<
  typeof ThreadPrimitive.Unstable_MessageById
>["components"]

export type ThreadMessageListHandle = {
  /**
   * Brings a message into the mounted window. Returns true once its element
   * is in the document, false while the thread is still scrolling it in.
   */
  revealMessage(messageId: string): boolean
}

function messageElement(viewport: HTMLElement | null, messageId: string) {
  return viewport?.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`
  )
}

/**
 * Where the browser keeps the reader's place across a resize above the
 * viewport itself (`overflow-anchor`), the virtualizer must not correct too.
 * WebKit has no scroll anchoring, so there the virtualizer's own correction
 * for messages above the viewport stands in for it.
 */
function browserAnchorsScroll() {
  return (
    typeof CSS !== "undefined" &&
    CSS.supports?.("overflow-anchor", "auto") === true
  )
}

/** A message the reader is looking at, and its top within the viewport. */
type PrependAnchor = { messageId: string; top: number }

/**
 * What must stay in place as older messages land above: the reader's
 * bookmarked message, else the first one in view. Nothing while the reader
 * follows the latest content, which the reading position already keeps.
 */
function readPrependAnchor(
  viewport: HTMLElement,
  bookmark: ThreadReadingBookmark | undefined
): PrependAnchor | null {
  const place = bookmark ?? captureThreadReadingBookmark(viewport)
  if (place.mode === "follow") return null
  const message =
    (place.messageId && messageElement(viewport, place.messageId)) ||
    firstVisibleMessage(viewport)
  const messageId = message?.dataset.messageId
  return message && messageId
    ? { messageId, top: topWithin(viewport, message) }
    : null
}

function topWithin(viewport: HTMLElement, element: HTMLElement) {
  return (
    element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  )
}

/**
 * The list's top within the viewport's scrolled content. The viewport is
 * positioned, so the list's offset chain ends at it and ignores scrolling.
 */
function offsetWithin(viewport: HTMLElement, list: HTMLElement) {
  let top = 0
  for (
    let element: Element | null = list;
    element instanceof HTMLElement && element !== viewport;
    element = element.offsetParent
  )
    top += element.offsetTop
  return top
}

/**
 * The virtualizer re-applies its last known offset whenever it re-attaches,
 * as a Session opens, and the viewport's smooth scrolling animated that stale
 * offset before the reading position restored the thread. The virtualizer
 * therefore moves the viewport only to correct a measured size change (where
 * the browser does not anchor scroll), and instantly.
 */
function correctScrollOnly(
  offset: number,
  { adjustments }: { adjustments?: number },
  instance: Virtualizer<HTMLElement, Element>
) {
  const viewport = instance.scrollElement
  if (viewport && adjustments)
    setScrollTopImmediately(viewport, offset + adjustments)
}

function setScrollTopImmediately(viewport: HTMLElement, scrollTop: number) {
  const previousScrollBehavior = viewport.style.scrollBehavior
  viewport.style.scrollBehavior = "auto"
  viewport.scrollTop = scrollTop
  viewport.style.scrollBehavior = previousScrollBehavior
}

/**
 * The thread's messages, virtualized: only the messages near the viewport are
 * mounted, following assistant-ui's virtualization guide
 * (`unstable_useThreadMessageIds` with `ThreadPrimitive.Unstable_MessageById`).
 * Spacing before and after the mounted window stands in for the rest, so the
 * rows stay in normal flow.
 *
 * The virtualizer never moves the scroll position on its own. The
 * reading-position controller and the browser's scroll anchoring already keep
 * the reader's place and follow the latest content; a second correction from
 * here would double every adjustment while a message streams.
 */
export function ThreadMessageList({
  viewportRef,
  readingBookmark,
  components,
  className,
  ref,
}: {
  viewportRef: RefObject<HTMLElement | null>
  /** The reader's current place, which a page of older messages keeps. */
  readingBookmark?: () => ThreadReadingBookmark | undefined
  components: MessageComponents
  className?: string
  ref?: Ref<ThreadMessageListHandle>
}) {
  const messageIds = unstable_useThreadMessageIds()
  const [anchorsScroll] = useState(browserAnchorsScroll)
  const listRef = useRef<HTMLDivElement>(null)
  // What sits above the list in the viewport (padding, the search bar) offsets
  // every message, so the window and `getOffsetForIndex` count it in.
  const [scrollMargin, setScrollMargin] = useState(0)
  // The last message to hold focus stays mounted, so scrolling never pulls
  // focus out from under the keyboard and a menu can return focus to it.
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
  const count = messageIds.length

  // Older messages landed above when the first message changed and the old
  // first one is still here. The reader's place is read now, before the page
  // commits and moves it.
  const firstMessageId = messageIds[0]
  const [shownFirstMessageId, setShownFirstMessageId] = useState(firstMessageId)
  const [prependAnchor, setPrependAnchor] = useState<PrependAnchor | null>(null)
  if (firstMessageId !== shownFirstMessageId) {
    setShownFirstMessageId(firstMessageId)
    const viewport = viewportRef.current
    if (
      viewport &&
      shownFirstMessageId !== undefined &&
      messageIds.includes(shownFirstMessageId)
    )
      setPrependAnchor(readPrependAnchor(viewport, readingBookmark?.()))
  }

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range)
      // The focused message, and the prepend anchor for the commit it moves.
      const kept = [focusedMessageId, prependAnchor?.messageId]
        .map((messageId) => (messageId ? messageIds.indexOf(messageId) : -1))
        .filter((index) => index >= 0 && !indexes.includes(index))
      if (kept.length === 0) return indexes
      return [...new Set([...indexes, ...kept])].sort(
        (left, right) => left - right
      )
    },
    [focusedMessageId, messageIds, prependAnchor]
  )

  // The list re-renders with every virtualizer change by design, so the
  // compiler skipping its memoization costs nothing.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ESTIMATED_MESSAGE_HEIGHT_PX,
    getItemKey: (index) => messageIds[index] ?? index,
    initialOffset: () => viewportRef.current?.scrollTop ?? 0,
    overscan: OVERSCAN,
    rangeExtractor,
    scrollMargin,
    scrollToFn: correctScrollOnly,
  })
  // An instance field, not an option. Where the browser anchors scroll, the
  // reading-position controller and the browser keep the reader's place.
  if (anchorsScroll)
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false

  // Once the page is in, the anchor returns to where the reader saw it, in one
  // instant move. Where the browser already anchored it, nothing moves.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!prependAnchor || !viewport) return
    // This commit laid out its window from the offset before the page, so it
    // may show messages never measured, at their real size. Recording those
    // sizes first keeps the spacing that later stands in for them true to
    // what the reader sees; the correction below then accounts for any move.
    for (const row of listRef.current?.children ?? [])
      virtualizer.resizeItem(
        virtualizer.indexFromElement(row),
        virtualizer.options.measureElement(row, undefined, virtualizer)
      )
    const message = messageElement(viewport, prependAnchor.messageId)
    const shift = message ? topWithin(viewport, message) - prependAnchor.top : 0
    if (shift !== 0)
      setScrollTopImmediately(viewport, viewport.scrollTop + shift)
    // The next window follows the corrected place, not the old offset, even
    // before the browser reports the scroll.
    virtualizer.scrollOffset = viewport.scrollTop
    // The anchor stays mounted for this commit only.
    setPrependAnchor(null)
  }, [prependAnchor, viewportRef, virtualizer])

  // The list re-renders on every scroll, so the margin follows what moves above
  // it; an unchanged value bails out of the update, so it cannot loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const list = listRef.current
    if (viewport && list) setScrollMargin(offsetWithin(viewport, list))
  })

  useImperativeHandle(
    ref,
    () => ({
      revealMessage(messageId) {
        const viewport = viewportRef.current
        if (!viewport || messageElement(viewport, messageId)) return true
        const index = messageIds.indexOf(messageId)
        if (index < 0) return true
        const offset = virtualizer.getOffsetForIndex(index, "center")?.[0]
        if (offset !== undefined) setScrollTopImmediately(viewport, offset)
        return false
      },
    }),
    [messageIds, viewportRef, virtualizer]
  )

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const row = (event.target as Element).closest<HTMLElement>("[data-index]")
    const messageId = row ? messageIds[Number(row.dataset.index)] : undefined
    if (messageId && messageId !== focusedMessageId)
      setFocusedMessageId(messageId)
  }

  // A short Session skips the window, so it also renders before layout.
  const whole = count <= WHOLE_THREAD_MESSAGE_LIMIT
  // Read in both modes, so the virtualizer's measurements follow every commit.
  const virtualItems = virtualizer.getVirtualItems()
  const items = whole
    ? messageIds.map((key, index) => ({ key, index, start: 0, end: 0 }))
    : virtualItems
  const remainder = whole
    ? 0
    : virtualizer.getTotalSize() + scrollMargin - (items.at(-1)?.end ?? 0)
  return (
    <div
      ref={listRef}
      className={cn("flex flex-col", className)}
      style={remainder > 0 ? { paddingBottom: remainder } : undefined}
      onFocus={onFocus}
    >
      {items.map((item, position) => {
        const messageId = messageIds[item.index]
        if (!messageId) return null
        const gap = item.start - (items[position - 1]?.end ?? scrollMargin)
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className={cn("flex flex-col", item.index < count - 1 && "pb-6")}
            style={gap > 0 ? { marginTop: gap } : undefined}
          >
            <ThreadPrimitive.Unstable_MessageById
              messageId={messageId}
              components={components}
            />
          </div>
        )
      })}
    </div>
  )
}
