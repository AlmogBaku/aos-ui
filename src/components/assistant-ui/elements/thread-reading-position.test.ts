import { cleanup, render } from "@testing-library/react"
import { createElement, useRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ThreadReadingPositionController,
  captureThreadReadingBookmark,
  restoreThreadReadingBookmark,
  useThreadReadingPosition,
} from "./thread-reading-position"

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setMetric(
  element: HTMLElement,
  property: "clientHeight" | "scrollHeight",
  value: number
) {
  Object.defineProperty(element, property, { configurable: true, value })
}

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 320,
    top,
    width: 320,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

function createViewport({
  clientHeight = 400,
  scrollHeight = 1_200,
  scrollTop = 0,
}: {
  clientHeight?: number
  scrollHeight?: number
  scrollTop?: number
} = {}) {
  const viewport = document.createElement("div")
  setMetric(viewport, "clientHeight", clientHeight)
  setMetric(viewport, "scrollHeight", scrollHeight)
  viewport.scrollTop = scrollTop
  viewport.getBoundingClientRect = () => rect(100, clientHeight)
  document.body.append(viewport)
  return viewport
}

function appendMessage(
  viewport: HTMLElement,
  id: string,
  top: number,
  height = 100
) {
  const message = document.createElement("article")
  message.dataset.messageId = id
  message.getBoundingClientRect = () => rect(top, height)
  viewport.append(message)
  return message
}

describe("thread reading position", () => {
  it("captures follow mode near the bottom", () => {
    const viewport = createViewport({ scrollTop: 770 })

    expect(captureThreadReadingBookmark(viewport)).toEqual({ mode: "follow" })
  })

  it("captures the first visible message anchor while reading history", () => {
    const viewport = createViewport({ scrollTop: 300 })
    appendMessage(viewport, "above", -20)
    appendMessage(viewport, "anchor", 80, 120)
    appendMessage(viewport, "next", 220)

    expect(captureThreadReadingBookmark(viewport)).toEqual({
      mode: "reading",
      messageId: "anchor",
      offsetPx: -20,
      scrollTop: 300,
    })
  })

  it("restores a message anchor without smooth scrolling", () => {
    const viewport = createViewport({ scrollTop: 600 })
    viewport.style.scrollBehavior = "smooth"
    appendMessage(viewport, "anchor", 180)

    restoreThreadReadingBookmark(viewport, {
      mode: "reading",
      messageId: "anchor",
      offsetPx: 20,
      scrollTop: 250,
    })

    expect(viewport.scrollTop).toBe(660)
    expect(viewport.style.scrollBehavior).toBe("smooth")
  })

  it("falls back to a clamped saved scroll position when its anchor is gone", () => {
    const viewport = createViewport({
      clientHeight: 400,
      scrollHeight: 900,
    })

    restoreThreadReadingBookmark(viewport, {
      mode: "reading",
      messageId: "removed",
      offsetPx: 0,
      scrollTop: 750,
    })

    expect(viewport.scrollTop).toBe(500)
  })

  it("opens an unseen thread at its latest content", () => {
    const controller = new ThreadReadingPositionController()
    const viewport = createViewport({
      clientHeight: 400,
      scrollHeight: 900,
    })

    expect(controller.restore("new-thread", viewport)).toEqual({
      mode: "follow",
    })
    expect(viewport.scrollTop).toBe(500)
  })

  it("keeps bookmarks independent by thread for the controller lifetime", () => {
    const controller = new ThreadReadingPositionController()
    const viewport = createViewport({ scrollTop: 300 })
    appendMessage(viewport, "a-anchor", 120)

    controller.capture("thread-a", viewport)
    viewport.replaceChildren()
    viewport.scrollTop = 0
    appendMessage(viewport, "b-anchor", 120)
    controller.capture("thread-b", viewport)

    viewport.replaceChildren()
    viewport.scrollTop = 500
    appendMessage(viewport, "a-anchor", 150)
    controller.restore("thread-a", viewport)

    expect(viewport.scrollTop).toBe(530)
  })

  it("re-anchors historical reading after incoming content changes layout", () => {
    const controller = new ThreadReadingPositionController()
    const viewport = createViewport({ scrollTop: 300 })
    const anchor = appendMessage(viewport, "anchor", 120)
    controller.capture("thread-a", viewport)

    anchor.getBoundingClientRect = () => rect(200, 100)
    controller.syncAfterContentChange("thread-a", viewport)

    expect(viewport.scrollTop).toBe(380)
  })

  it("looks up a saved anchor directly when restoring it", () => {
    const controller = new ThreadReadingPositionController()
    const viewport = createViewport({ scrollTop: 300 })
    const anchor = appendMessage(viewport, "anchor", 120)
    controller.capture("thread-a", viewport)
    const scan = vi.spyOn(viewport, "querySelectorAll")

    anchor.getBoundingClientRect = () => rect(200, 100)
    controller.syncAfterContentChange("thread-a", viewport)

    expect(scan).not.toHaveBeenCalled()
    expect(viewport.scrollTop).toBe(380)
  })

  it("does not write scrollTop when the restored position is unchanged", () => {
    const viewport = createViewport({
      clientHeight: 400,
      scrollHeight: 900,
      scrollTop: 500,
    })
    let scrollTop = 500
    const write = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: write,
    })

    restoreThreadReadingBookmark(viewport, { mode: "follow" })

    expect(write).not.toHaveBeenCalled()
  })

  it("coalesces scroll and content resize work into one animation frame", () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrame += 1
      frames.set(nextFrame, callback)
      return nextFrame
    })
    const cancelFrame = vi.fn((frame: number) => frames.delete(frame))
    vi.stubGlobal("cancelAnimationFrame", cancelFrame)

    let resize: ResizeObserverCallback | undefined
    const disconnect = vi.fn()
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback
        }
        observe() {}
        disconnect() {
          disconnect()
        }
      }
    )
    const capture = vi.spyOn(
      ThreadReadingPositionController.prototype,
      "capture"
    )
    const sync = vi.spyOn(
      ThreadReadingPositionController.prototype,
      "syncAfterContentChange"
    )

    function Harness() {
      const viewportRef = useRef<HTMLDivElement>(null)
      useThreadReadingPosition({
        threadId: "thread-a",
        contentReady: true,
        viewportRef,
      })
      return createElement(
        "div",
        { ref: viewportRef, "data-testid": "viewport" },
        createElement("div", { "data-slot": "aui_message-group" })
      )
    }

    const view = render(createElement(Harness))
    capture.mockClear()
    sync.mockClear()
    const viewport = view.getByTestId("viewport")

    viewport.dispatchEvent(new Event("scroll"))
    viewport.dispatchEvent(new Event("scroll"))
    resize?.([], {} as ResizeObserver)

    expect(frames).toHaveLength(1)
    const [[frame, callback]] = frames
    frames.delete(frame)
    callback(0)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(sync).not.toHaveBeenCalled()

    resize?.([], {} as ResizeObserver)
    resize?.([], {} as ResizeObserver)
    expect(frames).toHaveLength(1)
    const [[resizeFrame, resizeCallback]] = frames
    frames.delete(resizeFrame)
    resizeCallback(1)
    expect(sync).toHaveBeenCalledTimes(1)

    resize?.([], {} as ResizeObserver)
    view.unmount()
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
