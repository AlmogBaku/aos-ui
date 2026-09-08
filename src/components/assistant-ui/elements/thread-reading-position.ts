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

function findMessage(viewport: HTMLElement, messageId: string) {
  return messageElements(viewport).find(
    (message) => message.dataset.messageId === messageId
  )
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
    viewport.scrollTop = maximumScrollTop(viewport)
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

    viewport.scrollTop = clampScrollTop(viewport, targetScrollTop)
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

  constructor(bottomThresholdPx = DEFAULT_BOTTOM_THRESHOLD_PX) {
    this.#bottomThresholdPx = bottomThresholdPx
  }

  capture(threadId: string, viewport: HTMLElement) {
    const bookmark = captureThreadReadingBookmark(
      viewport,
      this.#bottomThresholdPx
    )
    this.#bookmarks.set(threadId, bookmark)
    return bookmark
  }

  restore(threadId: string, viewport: HTMLElement) {
    const bookmark = this.#bookmarks.get(threadId) ?? { mode: "follow" }
    restoreThreadReadingBookmark(viewport, bookmark)
    return bookmark
  }

  syncAfterContentChange(threadId: string, viewport: HTMLElement) {
    const bookmark = this.#bookmarks.get(threadId)
    if (!bookmark) return
    restoreThreadReadingBookmark(viewport, bookmark)
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
 * `scrollToBottomOnThreadSwitch={false}` on the viewport because this hook owns
 * instant restoration and follow mode. The listener keeps a historical anchor
 * fixed as streamed content changes height, while unseen Sessions and followed
 * Sessions open at the latest content.
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

    const capture = () => controller.capture(threadId, viewport)
    viewport.addEventListener("scroll", capture, { passive: true })

    const content = viewport.querySelector<HTMLElement>(
      '[data-slot="aui_message-group"]'
    )
    const resizeObserver =
      content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() =>
            controller.syncAfterContentChange(threadId, viewport)
          )
        : null
    if (content) resizeObserver?.observe(content)

    return () => {
      viewport.removeEventListener("scroll", capture)
      resizeObserver?.disconnect()
    }
  }, [contentReady, controller, threadId, viewportRef])

  return controller
}
