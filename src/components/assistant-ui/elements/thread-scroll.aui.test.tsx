import {
  type AssistantRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetThreadTestEnvironment,
  TURN_TIMING,
  INITIAL_MESSAGES,
  LocalThread,
  type PagedThreadHandle,
  historyState,
  olderMessages,
  PagedThread,
} from "./thread.aui.test-helpers"

afterEach(resetThreadTestEnvironment)

describe("conversation search", () => {
  it("keeps the open query and selected occurrence when a message is appended", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    render(
      <LocalThread
        exposeRuntime={(value) => {
          runtime = value
        }}
        initialMessages={[
          {
            id: "first-launch",
            role: "user",
            content: [{ type: "text", text: "First launch note" }],
          },
          {
            id: "second-launch",
            role: "assistant",
            content: [{ type: "text", text: "Second launch note" }],
          },
        ]}
      />
    )
    window.dispatchEvent(new Event("aos:conversation-search"))
    const search = await screen.findByRole("searchbox", {
      name: "Search in conversation",
    })
    await user.type(search, "launch")
    expect(await screen.findByText("1 of 2")).toBeVisible()
    await user.keyboard("{Enter}")
    expect(screen.getByText("2 of 2")).toBeVisible()

    await act(async () => {
      runtime?.thread.append({
        role: "user",
        content: [{ type: "text", text: "Third launch note" }],
      })
    })

    expect(search).toBeInTheDocument()
    expect(search).toHaveValue("launch")
    expect(await screen.findByText("2 of 3")).toBeVisible()
  })
})

describe("virtualized thread", () => {
  // A deliberately coupled jsdom layout simulator: it knows the list's rows
  // and spacing, so the virtualizer has real sizes to work with.
  const VIEWPORT_HEIGHT = 600
  const MESSAGE_HEIGHT = 100
  /** The older-history row above the list, whatever it shows. */
  const TOP_ROW_HEIGHT = 40
  const LONG_THREAD_LENGTH = 200
  const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]'
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  const scrollTops = new WeakMap<HTMLElement, number>()
  const resizeCallbacks = new Set<() => void>()
  /**
   * The row the emulated browser keeps in place, with its content top and the
   * top margin it had when picked.
   */
  let anchor: { row: HTMLElement; top: number; margin: string } | undefined
  let adjusting = false

  function isViewport(element: HTMLElement) {
    return element.dataset.slot === "aui_thread-viewport"
  }

  function rows(viewport: Element) {
    return Array.from(viewport.querySelectorAll<HTMLElement>("[data-index]"))
  }

  function isList(element: HTMLElement) {
    return element.querySelector(":scope > [data-index]") !== null
  }

  /** The top row sits right before the list; the sr-only heading does not count. */
  function topRowHeight(viewport: Element) {
    const list = rows(viewport)[0]?.parentElement
    return list?.previousElementSibling instanceof HTMLDivElement
      ? TOP_ROW_HEIGHT
      : 0
  }

  /** A row's top within the viewport's scrolled content. */
  function rowTop(viewport: Element, row: HTMLElement) {
    let top = topRowHeight(viewport)
    for (const other of rows(viewport)) {
      top += Number.parseFloat(other.style.marginTop) || 0
      if (other === row) return top
      top += messageHeight(other)
    }
    return top
  }

  function rect(top: number, height: number) {
    return {
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: 800,
      width: 800,
      height,
      toJSON: () => ({}),
    } as DOMRect
  }

  /** The first row still in view, as the browser picks its anchor node. */
  function selectAnchor(viewport: HTMLElement) {
    const row = rows(viewport).find(
      (candidate) =>
        rowTop(viewport, candidate) + messageHeight(candidate) >
        viewport.scrollTop
    )
    anchor = row && {
      row,
      top: rowTop(viewport, row),
      margin: row.style.marginTop,
    }
  }

  /**
   * Native scroll anchoring, applied whenever layout is read: a moved anchor
   * shifts the scroll position by as much, then the anchor is picked again.
   * Like Chromium, it declines when the anchor's own margin changed.
   */
  function anchorScroll(viewport: HTMLElement) {
    if (adjusting) return
    adjusting = true
    try {
      if (
        anchor?.row.isConnected &&
        viewport.contains(anchor.row) &&
        anchor.row.style.marginTop === anchor.margin
      ) {
        const shift = rowTop(viewport, anchor.row) - anchor.top
        if (shift !== 0) viewport.scrollTop += shift
      }
      selectAnchor(viewport)
    } finally {
      adjusting = false
    }
  }

  /** One line per 40 characters, so a streaming message grows. */
  function messageHeight(row: HTMLElement) {
    const lines = Math.ceil((row.textContent?.length ?? 0) / 40)
    return MESSAGE_HEIGHT * Math.max(1, lines)
  }

  /** Laid out like a real page: the mounted rows plus the spacing around them. */
  function contentHeight(viewport: HTMLElement) {
    const mounted = rows(viewport)
    const list = mounted[0]?.parentElement
    return (
      topRowHeight(viewport) +
      mounted.reduce(
        (total, row) =>
          total +
          messageHeight(row) +
          (Number.parseFloat(row.style.marginTop) || 0),
        0
      ) +
      (Number.parseFloat(list?.style.paddingBottom ?? "") || 0)
    )
  }

  function maximumScrollTop(viewport: HTMLElement) {
    return Math.max(0, contentHeight(viewport) - VIEWPORT_HEIGHT)
  }

  function define(name: string, descriptor: PropertyDescriptor) {
    descriptors.set(
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    )
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      ...descriptor,
    })
  }

  beforeEach(() => {
    anchor = undefined
    define("offsetTop", {
      get(this: HTMLElement) {
        const viewport = this.closest(VIEWPORT_SELECTOR)
        return viewport && isList(this) ? topRowHeight(viewport) : 0
      },
    })
    define("getBoundingClientRect", {
      value(this: HTMLElement) {
        const viewport = this.closest<HTMLElement>(VIEWPORT_SELECTOR)
        if (!viewport) return Element.prototype.getBoundingClientRect.call(this)
        anchorScroll(viewport)
        if (this === viewport) return rect(0, VIEWPORT_HEIGHT)
        const row = this.closest<HTMLElement>("[data-index]")
        return row
          ? rect(rowTop(viewport, row) - viewport.scrollTop, messageHeight(row))
          : rect(0, 0)
      },
    })
    define("offsetHeight", {
      get(this: HTMLElement) {
        if (isViewport(this)) return VIEWPORT_HEIGHT
        return this.dataset.index === undefined ? 0 : messageHeight(this)
      },
    })
    define("offsetWidth", { get: () => 800 })
    define("clientHeight", {
      get(this: HTMLElement) {
        return isViewport(this) ? VIEWPORT_HEIGHT : 0
      },
    })
    define("scrollHeight", {
      get(this: HTMLElement) {
        return isViewport(this) ? contentHeight(this) : 0
      },
    })
    define("scrollTop", {
      get(this: HTMLElement) {
        return scrollTops.get(this) ?? 0
      },
      set(this: HTMLElement, value: number) {
        const next = isViewport(this)
          ? Math.min(maximumScrollTop(this), Math.max(0, value))
          : 0
        if (next === (scrollTops.get(this) ?? 0)) return
        scrollTops.set(this, next)
        if (!adjusting && isViewport(this)) selectAnchor(this)
        this.dispatchEvent(new Event("scroll"))
      },
    })
    // Like the browser's: every observed element reports its current size.
    vi.stubGlobal(
      "ResizeObserver",
      class implements ResizeObserver {
        readonly #targets = new Set<Element>()
        readonly #notify: () => void
        constructor(callback: ResizeObserverCallback) {
          this.#notify = () =>
            callback(
              Array.from(this.#targets, (target) => {
                const blockSize = (target as HTMLElement).offsetHeight
                return {
                  target,
                  borderBoxSize: [{ blockSize, inlineSize: 800 }],
                } as unknown as ResizeObserverEntry
              }),
              this
            )
          resizeCallbacks.add(this.#notify)
        }
        observe(target: Element) {
          this.#targets.add(target)
        }
        unobserve(target: Element) {
          this.#targets.delete(target)
        }
        disconnect() {
          this.#targets.clear()
          resizeCallbacks.delete(this.#notify)
        }
      }
    )
  })

  afterEach(() => {
    cleanup()
    for (const [name, descriptor] of descriptors) {
      if (descriptor)
        Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, name)
    }
    descriptors.clear()
    resizeCallbacks.clear()
    vi.unstubAllGlobals()
  })

  function longThread(marker?: { index: number; text: string }) {
    return Array.from(
      { length: LONG_THREAD_LENGTH },
      (_, index): ThreadMessageLike => ({
        id: `long-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text:
              marker?.index === index
                ? marker.text
                : `Long thread message ${index}`,
          },
        ],
      })
    )
  }

  /** Lets rows measure, the viewport react to growth, and frames run out. */
  async function settle(rounds = 6) {
    for (let round = 0; round < rounds; round += 1) {
      await act(async () => {
        const mounted = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR)
        if (mounted) anchorScroll(mounted)
        for (const notify of resizeCallbacks) notify()
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
      })
    }
  }

  function viewport() {
    const element = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR)
    if (!element) throw new Error("Thread viewport is not mounted")
    return element
  }

  function mountedMessageCount() {
    return document.querySelectorAll("[data-message-id]").length
  }

  it("mounts only the messages near the viewport and opens a long Session at its latest message", async () => {
    render(<LocalThread initialMessages={longThread()} />)
    await settle()

    expect(mountedMessageCount()).toBeGreaterThan(0)
    expect(mountedMessageCount()).toBeLessThanOrEqual(30)
    expect(
      screen.getByText(`Long thread message ${LONG_THREAD_LENGTH - 1}`)
    ).toBeInTheDocument()
    expect(screen.queryByText("Long thread message 0")).not.toBeInTheDocument()
  })

  it("finds a message outside the mounted window and reveals it", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        initialMessages={longThread({
          index: 12,
          text: "The zephyr checkpoint",
        })}
      />
    )
    await settle()
    expect(screen.queryByText("The zephyr checkpoint")).not.toBeInTheDocument()

    window.dispatchEvent(new Event("aos:conversation-search"))
    const search = await screen.findByRole("searchbox", {
      name: "Search in conversation",
    })
    await user.type(search, "zephyr")

    expect(await screen.findByText("1 of 1")).toBeVisible()
    expect(await screen.findByText("The zephyr checkpoint")).toBeInTheDocument()
    expect(mountedMessageCount()).toBeLessThanOrEqual(30)
  })

  it("keeps a fold the reader opened open after its message leaves the window and returns", async () => {
    const user = userEvent.setup()
    const messages = longThread()
    messages[LONG_THREAD_LENGTH - 1] = {
      id: "folded-turn",
      role: "assistant",
      metadata: { timing: TURN_TIMING },
      content: [
        { type: "text", text: "Checking the notes first." },
        {
          type: "tool-call",
          toolCallId: "read",
          toolName: "read_file",
          args: { path: "README.md" },
          result: "contents",
        },
        { type: "text", text: "The settled answer." },
      ],
    }
    render(<LocalThread initialMessages={messages} />)
    await settle()

    await user.click(
      await screen.findByRole("button", { name: "Worked for 29s" })
    )
    expect(
      screen.getByRole("button", { name: "Worked for 29s" })
    ).toHaveAttribute("aria-expanded", "true")

    // The focused message stays mounted, so the reader moves on to another.
    viewport().scrollTop = 0
    await settle()
    const elsewhere = screen.getByText("Long thread message 0")
    elsewhere.tabIndex = -1
    act(() => elsewhere.focus())
    await settle()
    expect(screen.queryByText("The settled answer.")).not.toBeInTheDocument()

    viewport().scrollTop = maximumScrollTop(viewport())
    await settle()
    expect(
      await screen.findByRole("button", { name: "Worked for 29s" })
    ).toHaveAttribute("aria-expanded", "true")
  })

  it("keeps the newest streamed content in view until the reader scrolls up", async () => {
    const gates: Array<() => void> = []
    const nextChunk = () =>
      new Promise<void>((resolve) => {
        gates.push(resolve)
      })
    const release = async () => {
      await waitFor(() => expect(gates).toHaveLength(1))
      await act(async () => gates.shift()?.())
    }
    const growing = "Streaming words that keep arriving".repeat(4)
    let runtime: AssistantRuntime | undefined
    const model: ChatModelAdapter = {
      async *run() {
        yield { content: [{ type: "text", text: "Streaming first words" }] }
        await nextChunk()
        yield { content: [{ type: "text", text: growing }] }
        await nextChunk()
        yield { content: [{ type: "text", text: growing.repeat(3) }] }
      },
    }
    render(
      <LocalThread
        initialMessages={longThread()}
        model={model}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    await settle()

    await act(async () => {
      runtime?.thread.append({
        role: "user",
        content: [{ type: "text", text: "Keep going" }],
      })
    })
    expect(await screen.findByText("Streaming first words")).toBeInTheDocument()
    await settle()
    expect(viewport().scrollTop).toBe(maximumScrollTop(viewport()))

    const beforeGrowth = viewport().scrollTop
    await release()
    expect(await screen.findByText(growing)).toBeInTheDocument()
    await settle()
    expect(viewport().scrollTop).toBeGreaterThan(beforeGrowth)
    expect(viewport().scrollTop).toBe(maximumScrollTop(viewport()))

    fireEvent.wheel(viewport())
    viewport().scrollTop = viewport().scrollTop - 300
    await settle()
    const readingTop = viewport().scrollTop

    await release()
    expect(await screen.findByText(growing.repeat(3))).toBeInTheDocument()
    await settle()
    expect(viewport().scrollTop).toBe(readingTop)
    expect(viewport().scrollTop).toBeLessThan(maximumScrollTop(viewport()))
  })

  /** The text of the first message the reader can see. */
  function firstVisibleText() {
    const message = Array.from(
      viewport().querySelectorAll<HTMLElement>("[data-message-id]")
    ).find((element) => element.getBoundingClientRect().bottom > 0)
    const text = /Long thread message \d+/.exec(message?.textContent ?? "")
    if (!text) throw new Error("No message is in view")
    return text[0]
  }

  const topOf = (text: string) =>
    screen.getByText(text).getBoundingClientRect().top

  describe("as older messages land", () => {
    it("keeps the reader's place in a long thread as older messages land above", async () => {
      const thread = createRef<PagedThreadHandle>()
      render(
        <PagedThread
          initialMessages={longThread()}
          history={historyState()}
          ref={thread}
        />
      )
      await settle()
      fireEvent.wheel(viewport())
      viewport().scrollTop = maximumScrollTop(viewport()) - 4000
      await settle()
      const reading = firstVisibleText()
      const top = topOf(reading)

      act(() => thread.current?.prepend(olderMessages(20)))

      // Already in place as the page commits, before any frame runs.
      expect(topOf(reading)).toBe(top)
      await settle()
      expect(topOf(reading)).toBe(top)
    })

    it("keeps a reader following the latest message at the bottom as a page lands", async () => {
      const thread = createRef<PagedThreadHandle>()
      render(
        <PagedThread
          initialMessages={longThread()}
          history={historyState()}
          ref={thread}
        />
      )
      await settle()
      expect(viewport().scrollTop).toBe(maximumScrollTop(viewport()))

      act(() => thread.current?.prepend(olderMessages(20)))
      await settle()

      expect(viewport().scrollTop).toBe(maximumScrollTop(viewport()))
      expect(
        screen.getByText(`Long thread message ${LONG_THREAD_LENGTH - 1}`)
      ).toBeInTheDocument()
    })

    it("keeps the reader's place as a page lands while the latest turn streams", async () => {
      const thread = createRef<PagedThreadHandle>()
      const growing = "Streaming words that keep arriving"
      render(
        <PagedThread
          initialMessages={longThread()}
          history={historyState()}
          running
          ref={thread}
        />
      )
      await settle()
      fireEvent.wheel(viewport())
      viewport().scrollTop = maximumScrollTop(viewport()) - 4000
      await settle()
      const reading = firstVisibleText()
      const top = topOf(reading)

      act(() => {
        thread.current?.stream(growing)
        thread.current?.prepend(olderMessages(20))
      })
      expect(topOf(reading)).toBe(top)
      act(() => thread.current?.stream(growing.repeat(4)))
      await settle()

      expect(topOf(reading)).toBe(top)
    })
  })
})

describe("thread older history", () => {
  it("offers earlier messages as a button that keeps focus and reports progress while the page loads", async () => {
    const user = userEvent.setup()
    const history = historyState()
    const { rerender } = render(
      <PagedThread initialMessages={INITIAL_MESSAGES} history={history} />
    )

    await user.click(
      await screen.findByRole("button", { name: "Load earlier messages" })
    )
    expect(history.loadOlder).toHaveBeenCalledTimes(1)

    rerender(
      <PagedThread
        initialMessages={INITIAL_MESSAGES}
        history={{ ...history, loading: true }}
      />
    )
    const loading = screen.getByRole("button", {
      name: "Loading earlier messages",
    })
    expect(loading).toHaveFocus()
    expect(
      screen.getByText("Loading earlier messages", {
        selector: '[role="status"]',
      })
    ).toBeInTheDocument()
    await user.click(loading)
    expect(history.loadOlder).toHaveBeenCalledTimes(1)
  })

  it("marks the beginning, or that earlier messages can't be loaded, in place of the button", () => {
    const { rerender } = render(
      <PagedThread
        initialMessages={INITIAL_MESSAGES}
        history={historyState({ hasOlder: false })}
      />
    )
    expect(screen.getByText("Beginning of conversation")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /earlier messages/i })
    ).not.toBeInTheDocument()

    rerender(
      <PagedThread
        initialMessages={INITIAL_MESSAGES}
        history={historyState({ hasOlder: false, truncated: true })}
      />
    )
    expect(
      screen.getByText("Earlier messages can't be loaded")
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Beginning of conversation")
    ).not.toBeInTheDocument()
  })

  it("shows nothing until the history is known, nor on a thread with no messages", () => {
    render(<PagedThread initialMessages={INITIAL_MESSAGES} />)
    const noTopRow = () => {
      expect(
        screen.queryByRole("button", { name: /earlier messages/i })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText("Beginning of conversation")
      ).not.toBeInTheDocument()
    }
    noTopRow()

    cleanup()
    render(<PagedThread initialMessages={[]} history={historyState()} />)
    expect(
      screen.getByRole("heading", { name: "How can I help you today?" })
    ).toBeInTheDocument()
    noTopRow()
  })

  describe("as the top nears", () => {
    const observers: {
      callback: IntersectionObserverCallback
      options: IntersectionObserverInit | undefined
    }[] = []

    beforeEach(() => {
      observers.length = 0
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(
            callback: IntersectionObserverCallback,
            options?: IntersectionObserverInit
          ) {
            observers.push({ callback, options })
          }
          observe() {}
          disconnect() {}
        }
      )
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    const intersect = () =>
      act(() => {
        const observer = observers.at(-1)
        observer?.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      })

    it("reads the next page once the top nears", async () => {
      const history = historyState()
      render(
        <PagedThread initialMessages={INITIAL_MESSAGES} history={history} />
      )
      await screen.findByRole("button", { name: "Load earlier messages" })

      intersect()
      expect(history.loadOlder).toHaveBeenCalledTimes(1)
    })

    it("waits for the button after a failed read instead of reading again", async () => {
      const user = userEvent.setup()
      const history = historyState({ failed: true })
      render(
        <PagedThread initialMessages={INITIAL_MESSAGES} history={history} />
      )
      await screen.findByRole("button", { name: "Load earlier messages" })

      intersect()
      expect(history.loadOlder).not.toHaveBeenCalled()
      await user.click(
        screen.getByRole("button", { name: "Load earlier messages" })
      )
      expect(history.loadOlder).toHaveBeenCalledTimes(1)
    })
  })
})
