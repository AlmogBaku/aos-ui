import { describe, expect, it } from "vitest"

import {
  ThreadReadingPositionController,
  captureThreadReadingBookmark,
  restoreThreadReadingBookmark,
} from "./thread-reading-position"

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
})
