import { useEffect, useLayoutEffect, useMemo, type RefObject } from "react"

const DEFAULT_BOTTOM_THRESHOLD_PX = 48
const MESSAGE_SELECTOR = "[data-message-id]"

export type ThreadReadingBookmark =
  | { mode: "follow" }
  | {
      mode: "reading"
      messageId: string | null
      offsetPx: number
      scrollTop: number
    }

function maximumScrollTop(viewport: HTMLElement) {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight)
}

function clampScrollTop(viewport: HTMLElement, scrollTop: number) {
  return Math.min(maximumScrollTop(viewport), Math.max(0, scrollTop))
}

function messageElements(viewport: HTMLElement) {
  return Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR))
}

function escapeAttributeValue(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(
      /[\n\r\f]/g,
      (character) => `\\${character.codePointAt(0)!.toString(16)} `
    )
    .replaceAll("\0", "�")
}

function findMessage(viewport: HTMLElement, messageId: string) {
  return viewport.querySelector<HTMLElement>(
    `[data-message-id="${escapeAttributeValue(messageId)}"]`
  )
}

function updateScrollTop(viewport: HTMLElement, scrollTop: number) {
  if (Math.abs(viewport.scrollTop - scrollTop) < 0.5) return
  viewport.scrollTop = scrollTop
}

export function captureThreadReadingBookmark(
  viewport: HTMLElement,
  bottomThresholdPx = DEFAULT_BOTTOM_THRESHOLD_PX
): ThreadReadingBookmark {
  const distanceFromBottom = maximumScrollTop(viewport) - viewport.scrollTop
  if (distanceFromBottom <= bottomThresholdPx) return { mode: "follow" }

  const viewportRect = viewport.getBoundingClientRect()
  const firstVisibleMessage = messageElements(viewport).find((message) => {
    const messageRect = message.getBoundingClientRect()
    return (
      messageRect.bottom > viewportRect.top &&
      messageRect.top < viewportRect.bottom
    )
  })

  return {
    mode: "reading",
    messageId: firstVisibleMessage?.dataset.messageId ?? null,
    offsetPx: firstVisibleMessage
      ? firstVisibleMessage.getBoundingClientRect().top - viewportRect.top
      : 0,
    scrollTop: viewport.scrollTop,
  }
}

export function restoreThreadReadingBookmark(
  viewport: HTMLElement,
  bookmark: ThreadReadingBookmark
) {
  const previousScrollBehavior = viewport.style.scrollBehavior
  viewport.style.scrollBehavior = "auto"

  if (bookmark.mode === "follow") {
    updateScrollTop(viewport, maximumScrollTop(viewport))
  } else {
    const anchor = bookmark.messageId
      ? findMessage(viewport, bookmark.messageId)
      : undefined

    const targetScrollTop = anchor
      ? viewport.scrollTop +
        (anchor.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          bookmark.offsetPx)
      : bookmark.scrollTop

    updateScrollTop(viewport, clampScrollTop(viewport, targetScrollTop))
  }

  viewport.style.scrollBehavior = previousScrollBehavior
}

/**
 * Visit-scoped store and DOM coordinator for thread reading positions.
 * Create one instance for each mounted workspace/runtime and discard it when
 * that runtime changes.
 */
export class ThreadReadingPositionController {
  readonly #bookmarks = new Map<string, ThreadReadingBookmark>()
  readonly #bottomThresholdPx: number
  /** Where the viewport last settled, so a scroll's direction is known. */
  #scrollTop = 0

  constructor(bottomThresholdPx = DEFAULT_BOTTOM_THRESHOLD_PX) {
    this.#bottomThresholdPx = bottomThresholdPx
  }

  /**
   * Only a scroll up leaves follow mode. A scroll down while following is
   * someone else catching up with grown content — Assistant UI's own smooth
   * scroll to the bottom — and a position captured mid-animation would pin
   * the thread short of its latest content.
   */
  capture(threadId: string, viewport: HTMLElement) {
    const previous = this.#bookmarks.get(threadId)
    const scrolledDown = viewport.scrollTop >= this.#scrollTop
    this.#scrollTop = viewport.scrollTop
    if (previous?.mode === "follow" && scrolledDown) return previous
    const bookmark = captureThreadReadingBookmark(
      viewport,
      this.#bottomThresholdPx
    )
    this.#bookmarks.set(threadId, bookmark)
    return bookmark
  }

  restore(threadId: string, viewport: HTMLElement) {
    let bookmark = this.#bookmarks.get(threadId)
    if (!bookmark) {
      bookmark = { mode: "follow" }
      this.#bookmarks.set(threadId, bookmark)
    }
    this.#apply(viewport, bookmark)
    return bookmark
  }

  syncAfterContentChange(threadId: string, viewport: HTMLElement) {
    const bookmark = this.#bookmarks.get(threadId)
    if (bookmark) this.#apply(viewport, bookmark)
  }

  #apply(viewport: HTMLElement, bookmark: ThreadReadingBookmark) {
    restoreThreadReadingBookmark(viewport, bookmark)
    this.#scrollTop = viewport.scrollTop
  }

  clear() {
    this.#bookmarks.clear()
  }
}

export type UseThreadReadingPositionOptions = {
  /** Current provider-owned Session/thread ID. */
  threadId: string | null
  /** False while the destination Session history is loading. */
  contentReady: boolean
  /** Ref attached directly to `ThreadPrimitive.Viewport`. */
  viewportRef: RefObject<HTMLElement | null>
  /** Change this value to start a fresh runtime-scoped bookmark store. */
  runtimeKey?: unknown
}

function createRuntimeScopedController(runtimeKey: unknown) {
  void runtimeKey
  return new ThreadReadingPositionController()
}

/**
 * Connects reading continuity to a Thread viewport.
 *
 * Integration in `Thread`:
 * 1. attach `viewportRef` to `ThreadPrimitive.Viewport`;
 * 2. pass `useAuiState(s => s.threadListItem.remoteId)` as `threadId`;
 * 3. pass false for `contentReady` while the history skeleton is visible;
 * 4. pass the selected Assistant runtime instance as `runtimeKey`.
 *
 * Set `autoScroll={false}`, `scrollToBottomOnInitialize={false}`, and
 * `scrollToBottomOnThreadSwitch={false}` with `turnAnchor="bottom"` on the
 * viewport because this hook owns instant restoration and follow mode. The
 * listener keeps a historical anchor fixed as streamed content changes height,
 * while unseen Sessions and followed Sessions open at the latest content.
 */
export function useThreadReadingPosition({
  threadId,
  contentReady,
  viewportRef,
  runtimeKey,
}: UseThreadReadingPositionOptions) {
  const controller = useMemo(
    () => createRuntimeScopedController(runtimeKey),
    [runtimeKey]
  )

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!threadId || !contentReady || !viewport) return
    controller.restore(threadId, viewport)
  }, [contentReady, controller, threadId, viewportRef])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!threadId || !contentReady || !viewport) return

    let frame: number | null = null
    let capturePending = false
    const schedule = (capture: boolean) => {
      capturePending ||= capture
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (capturePending) {
          capturePending = false
          controller.capture(threadId, viewport)
          return
        }
        controller.syncAfterContentChange(threadId, viewport)
      })
    }
    const capture = () => schedule(true)
    viewport.addEventListener("scroll", capture, { passive: true })

    const content = viewport.querySelector<HTMLElement>(
      '[data-slot="aui_message-group"]'
    )
    const resizeObserver =
      content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => schedule(false))
        : null
    if (content) resizeObserver?.observe(content)

    return () => {
      viewport.removeEventListener("scroll", capture)
      resizeObserver?.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [contentReady, controller, threadId, viewportRef])

  return controller
}
