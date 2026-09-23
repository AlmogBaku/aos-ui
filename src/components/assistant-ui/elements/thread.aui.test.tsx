import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  type AssistantRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
  useAuiState,
  useExternalStoreRuntime,
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  createRef,
  useImperativeHandle,
  useMemo,
  useState,
  type Ref,
} from "react"
import { createPortal } from "react-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createComposerHistorySelector,
  Thread,
  THREAD_VIEWPORT_SCROLL_BEHAVIOR,
  type ThreadComponents,
  type ThreadComposerOverrideProps,
  type ThreadLabels,
} from "./thread.aui"
import {
  AosToolPresentation,
  RichToolRenderer,
  ToolUiLocaleProvider,
  type ToolUiLocale,
} from "@/components/tool-ui"
import { McpAppHostProvider } from "@/components/mcp-apps/mcp-app-host"
import type { McpAppFrameProps } from "@/components/mcp-apps/mcp-app-frame"
import { MCP_APP_TOOL_ARTIFACT } from "@/components/mcp-apps/tool-part"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { PendingInteractionProvider } from "@/components/runtime-interactions/pending-interaction-context"
import type {
  McpAppAdapter,
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { steerMessageId } from "@/components/assistant-ui/elements/message-queue"
import { threadLabels } from "@/components/assistant-ui/thread-labels"
import {
  threadHistoryExtras,
  type ThreadHistoryState,
} from "@/runtime-adapters/thread-history"

// The sandboxed frame needs a real browser; a titled stand-in marks where it mounts.
vi.mock("@/components/mcp-apps/mcp-app-frame", () => ({
  default: (props: McpAppFrameProps) => <iframe title={props.title} />,
}))

const TOUCH_PRIMARY_QUERY = "(pointer: coarse) and (not (any-pointer: fine))"
const matchMediaDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia"
)

function setTouchPrimary(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query === TOUCH_PRIMARY_QUERY ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }),
  })
}

afterEach(() => {
  cleanup()
  if (matchMediaDescriptor) {
    Object.defineProperty(window, "matchMedia", matchMediaDescriptor)
  } else {
    Reflect.deleteProperty(window, "matchMedia")
  }
})

describe("composer history performance", () => {
  it("keeps history stable across assistant-only streaming updates", () => {
    const selectHistory = createComposerHistorySelector()
    const user = {
      id: "user-1",
      role: "user" as const,
      content: [{ type: "text" as const, text: "First prompt" }],
    }
    const first = selectHistory([
      user,
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "First token" }],
      },
    ])
    const next = selectHistory([
      user,
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "First token and more" }],
      },
    ])

    expect(next).toBe(first)
  })
})

describe("assistant source parts", () => {
  it("renders assistant-ui URL sources through the safe source element", () => {
    render(
      <LocalThread
        labels={{ openSource: "פתיחת מקור" }}
        initialMessages={[
          {
            id: "message-assistant-source",
            role: "assistant",
            content: [
              {
                type: "source",
                sourceType: "url",
                id: "source-1",
                title: "מסמכי OpenAI",
                url: "https://platform.openai.com/docs",
              },
            ],
          },
        ]}
      />
    )

    expect(
      screen.getByRole("link", { name: "פתיחת מקור: מסמכי OpenAI" })
    ).toHaveAttribute("href", "https://platform.openai.com/docs")
  })
})

const TURN_TIMING = {
  streamStartTime: Date.parse("2026-09-03T09:11:31.000Z"),
  totalStreamTime: 29_000,
  totalChunks: 48,
  toolCallCount: 3,
}

describe("settled turn fold", () => {
  it("collapses the turn's work behind one disclosure and keeps rich output outside it", async () => {
    const user = userEvent.setup()
    const apps = {
      open: vi.fn(async () => ({ html: "<p>chart</p>" })),
      callTool: vi.fn(),
      readResource: vi.fn(),
    } satisfies McpAppAdapter
    render(
      <McpAppHostProvider adapter={apps} agentId="agent" threadId="thread">
        <LocalThread
          toolFallback={AosToolPresentation}
          initialMessages={[
            {
              id: "tools-complete",
              role: "assistant",
              metadata: { timing: TURN_TIMING },
              content: [
                {
                  type: "reasoning",
                  text: "I should inspect the project before changing it.",
                },
                {
                  type: "tool-call",
                  toolCallId: "read",
                  toolName: "read_file",
                  args: { path: "README.md" },
                  result: "contents",
                },
                {
                  type: "tool-call",
                  toolCallId: "search",
                  toolName: "search",
                  args: { query: "assistant-ui" },
                  result: "matches",
                },
                {
                  type: "tool-call",
                  toolCallId: "skill",
                  toolName: "use_skill",
                  args: { skill: "kb" },
                  result: "private skill instructions must stay hidden",
                },
                {
                  type: "tool-call",
                  toolCallId: "chart",
                  toolName: "render_chart",
                  args: { title: "Investment trend" },
                  artifact: MCP_APP_TOOL_ARTIFACT,
                  result: "Chart ready for display.",
                },
                { type: "text", text: "The recommendation stays visible." },
              ],
            },
          ]}
        />
      </McpAppHostProvider>
    )

    const fold = await screen.findByRole("button", {
      name: "Worked for 29s",
    })
    expect(fold).toHaveAttribute("aria-expanded", "false")
    expect(await screen.findByTitle("render_chart app")).toBeVisible()
    expect(screen.getByText("The recommendation stays visible.")).toBeVisible()

    await user.click(fold)
    expect(fold).toHaveAttribute("aria-expanded", "true")
    expect(screen.getAllByText("Read")).toHaveLength(1)
    expect(screen.getAllByText("Searched")).toHaveLength(1)
    expect(screen.getAllByText("Loaded")).toHaveLength(1)
    expect(screen.getByText("kb")).toBeVisible()
    expect(
      screen.queryByText("private skill instructions must stay hidden")
    ).toBeNull()

    await user.click(screen.getByRole("button", { name: /^Reasoning$/ }))
    expect(
      screen.getByText("I should inspect the project before changing it.")
    ).toBeVisible()
  })

  it("keeps folded prose and tool runs in provider order", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        toolFallback={AosToolPresentation}
        initialMessages={[
          {
            id: "tool-loop-with-interleaved-prose",
            role: "assistant",
            metadata: { timing: TURN_TIMING },
            content: [
              {
                type: "tool-call",
                toolCallId: "read-project",
                toolName: "read_file",
                args: { path: "README.md" },
                result: "contents",
              },
              {
                type: "text",
                text: "Big finding already. Let me fix the call-site shape.",
              },
              {
                type: "tool-call",
                toolCallId: "fix-project",
                toolName: "edit_file",
                args: { path: "README.md" },
                result: "updated",
              },
              { type: "text", text: "The fix is in place." },
            ],
          },
        ]}
      />
    )

    expect(screen.getByText("The fix is in place.")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Worked for 29s" }))

    const firstRun = screen.getByText("Read 1 file")
    const prose = screen.getByText(
      "Big finding already. Let me fix the call-site shape."
    )
    const secondRun = screen.getByText("Changed 1 file")

    expect(prose).toBeVisible()
    expect(firstRun.compareDocumentPosition(prose)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(prose.compareDocumentPosition(secondRun)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it("drops the duration clause for a turn the provider did not time", async () => {
    render(
      <LocalThread
        toolFallback={AosToolPresentation}
        initialMessages={[
          {
            id: "tools-untimed",
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "read",
                toolName: "read_file",
                args: { path: "README.md" },
                result: "contents",
              },
              { type: "text", text: "Answered without timing." },
            ],
          },
        ]}
      />
    )

    expect(await screen.findByRole("button", { name: "Worked" })).toBeVisible()
  })

  it("folds nothing while the turn is still running", async () => {
    render(
      <LocalThread
        toolFallback={AosToolPresentation}
        initialMessages={[
          {
            id: "tools-running",
            role: "assistant",
            status: { type: "running" },
            content: [
              {
                type: "tool-call",
                toolCallId: "read",
                toolName: "read_file",
                args: { path: "README.md" },
                result: "contents",
              },
              { type: "text", text: "Partial answer so far" },
            ],
          },
        ]}
      />
    )

    expect(await screen.findByText("Working")).toBeVisible()
    expect(screen.queryByRole("button", { name: /worked/i })).toBeNull()
    expect(screen.getByRole("button", { name: "Running" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })
})

describe("thread scroll ownership", () => {
  it("follows new turns at the bottom through the reading-position controller", () => {
    expect(THREAD_VIEWPORT_SCROLL_BEHAVIOR).toEqual({
      autoScroll: false,
      scrollToBottomOnInitialize: false,
      scrollToBottomOnThreadSwitch: false,
      turnAnchor: "bottom",
    })
  })
})

describe("conversation search", () => {
  it("searches only the loaded branch and restores the triggering focus on Escape", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        initialMessages={[
          {
            id: "branch-user",
            role: "user",
            content: [{ type: "text", text: "Find the launch brief" }],
          },
          {
            id: "branch-assistant",
            role: "assistant",
            content: [{ type: "text", text: "The launch brief is ready." }],
          },
        ]}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    input.focus()

    window.dispatchEvent(new Event("aos:conversation-search"))

    const search = await screen.findByRole("searchbox", {
      name: "Search in conversation",
    })
    await user.type(search, "launch")
    expect(await screen.findByText("1 of 2")).toBeVisible()
    await user.keyboard("{Enter}")
    expect(screen.getByText("2 of 2")).toBeVisible()
    await user.keyboard("{Shift>}{Enter}{/Shift}")
    expect(screen.getByText("1 of 2")).toBeVisible()
    fireEvent.keyDown(search, { key: "Escape", bubbles: true })

    expect(search).not.toBeInTheDocument()
    await waitFor(() => expect(input).toHaveFocus())
  })

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

    it("keeps the reader's place near the top of a long thread as unmeasured messages mount above it", async () => {
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
      viewport().scrollTop = 150
      await settle()
      const reading = firstVisibleText()
      const top = topOf(reading)

      act(() => thread.current?.prepend(olderMessages(20)))
      await settle()

      expect(topOf(reading)).toBe(top)
    })

    it("keeps the reader's place at the top of a short thread as older messages land above", async () => {
      const thread = createRef<PagedThreadHandle>()
      render(
        <PagedThread
          initialMessages={longThread().slice(0, 20)}
          history={historyState()}
          ref={thread}
        />
      )
      await settle()
      fireEvent.wheel(viewport())
      viewport().scrollTop = 0
      await settle()
      const top = topOf("Long thread message 0")

      act(() => thread.current?.prepend(olderMessages(8)))

      expect(topOf("Long thread message 0")).toBe(top)
      await settle()
      expect(topOf("Long thread message 0")).toBe(top)
      expect(screen.getByText("Older message 7")).toBeInTheDocument()
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

  it("speaks Hebrew in the Hebrew thread", () => {
    const { rerender } = render(
      <PagedThread
        initialMessages={INITIAL_MESSAGES}
        history={historyState()}
        labels={threadLabels.he}
      />
    )
    expect(
      screen.getByRole("button", { name: "טעינת הודעות קודמות" })
    ).toBeInTheDocument()

    rerender(
      <PagedThread
        initialMessages={INITIAL_MESSAGES}
        history={historyState({ hasOlder: false })}
        labels={threadLabels.he}
      />
    )
    expect(screen.getByText("תחילת השיחה")).toBeInTheDocument()

    rerender(
      <PagedThread
        initialMessages={INITIAL_MESSAGES}
        history={historyState({ hasOlder: false, truncated: true })}
        labels={threadLabels.he}
      />
    )
    expect(screen.getByText("אי אפשר לטעון הודעות קודמות")).toBeInTheDocument()
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

    it("reads the next page a viewport before the top is reached", async () => {
      const history = historyState()
      render(
        <PagedThread initialMessages={INITIAL_MESSAGES} history={history} />
      )
      await screen.findByRole("button", { name: "Load earlier messages" })

      const { options } = observers.at(-1) ?? {}
      expect(options?.root).toBe(
        document.querySelector('[data-slot="aui_thread-viewport"]')
      )
      expect(options?.rootMargin).toBe("100% 0px 0px 0px")
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

const INITIAL_MESSAGES = [
  {
    id: "message-user",
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Review this image" },
      {
        type: "image" as const,
        image:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
        filename: "reference.svg",
      },
    ],
  },
  {
    id: "message-assistant",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "The reference is ready." }],
  },
]

/** A run that parks until the runtime aborts it, so a cancel is observable. */
function parkedRun(stop: () => void): ChatModelAdapter {
  return {
    async *run({ abortSignal }) {
      yield { content: [{ type: "text", text: "Waiting on native run" }] }
      await new Promise<void>((resolve) =>
        abortSignal.addEventListener(
          "abort",
          () => {
            stop()
            resolve()
          },
          { once: true }
        )
      )
    },
  }
}

/** Sends one message through `parkedRun` and returns the composer input. */
async function startParkedRun(user: ReturnType<typeof userEvent.setup>) {
  const input = await screen.findByRole("textbox", { name: "Message input" })
  await user.type(input, "Run")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  await screen.findByText("Waiting on native run")
  return input
}

/**
 * Two overlays with the same dialog role: one inside the Thread, one whose DOM
 * leaves it through a portal while its React events still bubble to the
 * viewport.
 */
function OverlayComposer({ fallback }: ThreadComposerOverrideProps) {
  return (
    <>
      {fallback}
      <div role="dialog" aria-label="Inline overlay" />
      {createPortal(
        <div role="dialog" aria-label="Portaled overlay" />,
        document.body
      )}
    </>
  )
}

function messageText(message: ThreadMessage | ThreadMessageLike) {
  const content =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function LocalThread({
  labels,
  direction,
  model = { run: async () => ({ content: [] }) },
  exposeRuntime,
  initialMessages = INITIAL_MESSAGES,
  toolFallback,
  composer,
  composerFeatures,
  enableMessageQueue = false,
  attachmentAdapter,
  messageRewind,
  locale,
}: {
  labels?: Partial<ThreadLabels>
  direction?: "ltr" | "rtl"
  locale?: ToolUiLocale
  model?: ChatModelAdapter
  exposeRuntime?: (runtime: AssistantRuntime) => void
  initialMessages?: readonly ThreadMessageLike[]
  toolFallback?: typeof RichToolRenderer
  composer?: ThreadComponents["Composer"]
  composerFeatures?: ComposerFeatureViewModel
  enableMessageQueue?: boolean
  attachmentAdapter?: AttachmentAdapter
  messageRewind?:
    | false
    | {
        runConfig(sourceUserId: string): {
          custom: Record<string, unknown>
        }
      }
}) {
  const runtime = useLocalRuntime(model, {
    initialMessages,
    unstable_enableMessageQueue: enableMessageQueue,
    unstable_queueClearOnCancel: false,
    adapters: attachmentAdapter
      ? { attachments: attachmentAdapter }
      : undefined,
  })
  exposeRuntime?.(runtime)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUiLocaleProvider locale={locale}>
        <Thread
          labels={labels}
          direction={direction}
          autoFocus={false}
          composerFeatures={composerFeatures}
          components={{ ToolFallback: toolFallback, Composer: composer }}
          messageRewind={messageRewind}
        />
      </ToolUiLocaleProvider>
    </AssistantRuntimeProvider>
  )
}

type PagedThreadHandle = {
  prepend(older: readonly ThreadMessageLike[]): void
}

function historyState(
  overrides: Partial<ThreadHistoryState> = {}
): ThreadHistoryState & { loadOlder: ReturnType<typeof vi.fn> } {
  return {
    hasOlder: true,
    truncated: false,
    loading: false,
    failed: false,
    loadOlder: vi.fn(async () => {}),
    ...overrides,
  } as ThreadHistoryState & { loadOlder: ReturnType<typeof vi.fn> }
}

function olderMessages(count: number): ThreadMessageLike[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `older-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Older message ${index}` }],
  }))
}

const asMessage = (message: ThreadMessageLike) => message

/**
 * An external-store thread whose older history the test controls: it offers
 * the given history state and prepends the pages the test hands it.
 */
function PagedThread({
  initialMessages,
  history,
  labels,
  ref,
}: {
  initialMessages: readonly ThreadMessageLike[]
  history?: ThreadHistoryState
  labels?: Partial<ThreadLabels>
  ref?: Ref<PagedThreadHandle>
}) {
  const [messages, setMessages] = useState(initialMessages)
  const extras = useMemo(
    () =>
      history === undefined
        ? undefined
        : threadHistoryExtras.provide({ history }),
    [history]
  )
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: asMessage,
    onNew: async () => {},
    extras,
  })
  useImperativeHandle(ref, () => ({
    prepend: (older) => setMessages((current) => [...older, ...current]),
  }))
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread autoFocus={false} labels={labels} />
    </AssistantRuntimeProvider>
  )
}

const MULTI_SESSION_MESSAGES: Record<string, readonly ThreadMessageLike[]> = {
  "session-one": [],
  "session-two": [
    {
      id: "session-two-history",
      role: "user",
      content: [{ type: "text", text: "Session two history" }],
    },
  ],
}

const multiSessionAdapter = {
  list: async () => ({
    threads: ["session-one", "session-two"].map((remoteId) => ({
      remoteId,
      status: "regular" as const,
    })),
  }),
  fetch: async (remoteId: string) => ({
    remoteId,
    status: "regular" as const,
  }),
  initialize: async (threadId: string) => ({
    remoteId: threadId,
  }),
  rename: async () => undefined,
  updateCustom: async () => undefined,
  archive: async () => undefined,
  unarchive: async () => undefined,
  delete: async () => undefined,
  generateTitle: async () =>
    new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
}

function MultiSessionThread({
  exposeRuntime,
}: {
  exposeRuntime?: (runtime: AssistantRuntime) => void
}) {
  const runtime = useRemoteThreadListRuntime({
    adapter: multiSessionAdapter,
    initialThreadId: "session-one",
    runtimeHook: useMultiSessionRuntime,
  })
  exposeRuntime?.(runtime)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread autoFocus={false} />
    </AssistantRuntimeProvider>
  )
}

/*
 * Keep the runtime hook named so eslint can verify that the hooks it calls
 * follow the Rules of Hooks. The remote runtime invokes it inside a thread
 * scope, where threadListItem.remoteId is available.
 */
function useMultiSessionRuntime() {
  const threadId = useAuiState((state) => state.threadListItem.remoteId)
  return useLocalRuntime(
    { run: async () => ({ content: [] }) },
    { initialMessages: MULTI_SESSION_MESSAGES[threadId ?? "session-one"] }
  )
}

describe("Thread accessibility", () => {
  it("uses Shift+Enter for newlines and plain Enter to send a desktop draft", async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Done" }],
    }))
    render(<LocalThread model={{ run }} initialMessages={[]} />)

    const input = await screen.findByRole("textbox", { name: "Message input" })
    expect(input).toHaveAttribute("enterkeyhint", "enter")

    await user.type(input, "First line")
    await user.keyboard("{Shift>}{Enter}{/Shift}")
    await user.type(input, "Second line")

    expect(input).toHaveValue("First line\nSecond line")
    expect(run).not.toHaveBeenCalled()

    await user.keyboard("{Enter}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(input).toHaveValue("")
  })

  it("uses plain Return for newlines on a touch-primary device", async () => {
    setTouchPrimary(true)
    const user = userEvent.setup()
    const run = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Done" }],
    }))
    render(<LocalThread model={{ run }} initialMessages={[]} />)

    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "First line")
    await user.keyboard("{Enter}")
    await user.type(input, "Second line")

    expect(input).toHaveValue("First line\nSecond line")
    expect(run).not.toHaveBeenCalled()

    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
  })

  it("renders the welcome state accessibly", () => {
    render(<LocalThread initialMessages={[]} />)

    expect(
      screen.getByRole("heading", { name: "How can I help you today?" })
    ).toBeVisible()
  })

  it("renders populated thread content", async () => {
    render(<LocalThread />)

    await screen.findByText("The reference is ready.")
    expect(screen.getByText("The reference is ready.")).toBeVisible()
  })

  it("renders both roles' prose through one Markdown mechanism", async () => {
    render(
      <LocalThread
        initialMessages={[
          {
            id: "asked",
            role: "user",
            content: [{ type: "text", text: "Read **README.md** first." }],
          },
          {
            id: "answered",
            role: "assistant",
            content: [{ type: "text", text: "Reading **README.md** now." }],
          },
        ]}
      />
    )

    const emphasized = await screen.findAllByText("README.md", {
      selector: "strong",
    })
    expect(emphasized).toHaveLength(2)
    for (const element of emphasized) expect(element).toBeVisible()
  })

  it("copies assistant text when the Clipboard API is unavailable", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard"
    )
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    })
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "execCommand"
    )
    let copiedText = ""
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((command: string) => {
        if (command !== "copy") return false
        const selected = document.activeElement
        copiedText =
          selected instanceof HTMLTextAreaElement ? selected.value : ""
        return true
      }),
    })

    try {
      render(<LocalThread />)

      const copy = await screen.findByRole("button", { name: "Copy" })
      fireEvent.click(copy)

      await waitFor(() => expect(copy).toHaveAttribute("data-copied", "true"))
      expect(copiedText).toBe("The reference is ready.")
    } finally {
      if (execCommandDescriptor) {
        Object.defineProperty(document, "execCommand", execCommandDescriptor)
      } else {
        Reflect.deleteProperty(document, "execCommand")
      }
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor)
      } else {
        Reflect.deleteProperty(navigator, "clipboard")
      }
    }
  })

  it("does not render a completed assistant turn with no content", () => {
    render(
      <LocalThread
        initialMessages={[
          {
            id: "message-user",
            role: "user",
            content: [{ type: "text", text: "Continue?" }],
          },
          {
            id: "discard-resume",
            role: "assistant",
            content: [],
          },
        ]}
      />
    )

    expect(screen.getByText("Continue?")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull()
  })

  it("allows a provider interaction to replace the normal composer", async () => {
    render(
      <LocalThread
        composer={() => (
          <section aria-label="Provider question">Question</section>
        )}
      />
    )

    expect(
      await screen.findByRole("region", { name: "Provider question" })
    ).toBeVisible()
    expect(screen.queryByRole("textbox", { name: "Message input" })).toBeNull()
  })

  it("gives a populated conversation a localized level-one heading", async () => {
    render(<LocalThread labels={{ conversationHeading: "שיחת הסוכן" }} />)

    await screen.findByText("The reference is ready.")
    expect(
      screen.getByRole("heading", { level: 1, name: "שיחת הסוכן" })
    ).toBeInTheDocument()
  })

  it("renders provider subagent messages as a nested read-only transcript", async () => {
    const nestedMessages: readonly ThreadMessage[] = [
      {
        id: "message-user",
        role: "user",
        content: [{ type: "text", text: "Review the figures" }],
        createdAt: new Date("2026-09-04T08:00:00.000Z"),
        status: { type: "complete", reason: "stop" },
        attachments: [],
        metadata: { custom: {} },
      },
      {
        id: "message-assistant",
        role: "assistant",
        content: [{ type: "text", text: "Validated the three segments." }],
        createdAt: new Date("2026-09-04T08:00:00.000Z"),
        status: { type: "complete", reason: "stop" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ]
    const messages: readonly ThreadMessageLike[] = [
      {
        id: "parent-assistant",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "subagent-1",
            toolName: "delegate_subagent",
            args: { task: "Validate market segments" },
            result: {
              name: "Data analyst",
              status: "completed",
              summary: "Analysis complete.",
            },
            messages: nestedMessages,
          },
        ],
      },
    ]

    render(
      <LocalThread initialMessages={messages} toolFallback={RichToolRenderer} />
    )

    await screen.findByText("Data analyst")
    expect(screen.getByText("Validated the three segments.")).toBeVisible()

    const transcript = document.querySelector<HTMLElement>(
      '[data-slot="nested-activity-transcript"]'
    )
    expect(transcript).toBeInTheDocument()
    expect(
      screen.getByText("Review the figures").closest('[data-role="user"]')
    ).toBeInTheDocument()
    expect(
      screen
        .getByText("Validated the three segments.")
        .closest('[data-role="assistant"]')
    ).toBeInTheDocument()
    expect(within(transcript!).queryByRole("textbox")).toBeNull()
    expect(within(transcript!).queryByRole("button")).toBeNull()
  })

  it("announces the localized working state while a response streams", async () => {
    const user = userEvent.setup()
    let finish: (() => void) | undefined
    const model: ChatModelAdapter = {
      async *run() {
        yield { content: [{ type: "text", text: "Working" }] }
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
    }

    render(
      <LocalThread labels={{ assistantWorking: "הסוכן עובד" }} model={model} />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "Continue")
    await user.click(screen.getByRole("button", { name: "Send message" }))

    const status = screen.getByRole("status")
    await waitFor(() => expect(status).toHaveTextContent("הסוכן עובד"))
    expect(status).toHaveAttribute("aria-live", "polite")

    await act(async () => finish?.())
    await waitFor(() => expect(status).toBeEmptyDOMElement())
  })

  it("regenerates an assistant response and keeps both branches navigable", async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "The refreshed answer." }],
    }))

    render(<LocalThread model={{ run }} />)

    await user.click(await screen.findByRole("button", { name: "Refresh" }))

    expect(await screen.findByText("The refreshed answer.")).toBeInTheDocument()
    expect(run).toHaveBeenCalledTimes(1)
    expect(screen.getByText("2 / 2")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Previous" }))
    expect(screen.getByText("The reference is ready.")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByText("The refreshed answer.")).toBeInTheDocument()
  })

  it("carries the source user turn in the retry run config", async () => {
    const user = userEvent.setup()
    const runConfig = vi.fn((sourceUserId: string) => ({
      custom: { "aos.rewindSourceId": sourceUserId },
    }))
    const run = vi.fn(async () => ({ content: [] }))

    render(<LocalThread messageRewind={{ runConfig }} model={{ run }} />)

    await user.click(await screen.findByRole("button", { name: "Refresh" }))

    expect(runConfig).toHaveBeenCalledOnce()
    expect(runConfig).toHaveBeenCalledWith("message-user")
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        runConfig: {
          custom: { "aos.rewindSourceId": "message-user" },
        },
      })
    )
  })

  it("disables run-changing actions and queues follow-ups while an interaction is pending", async () => {
    const user = userEvent.setup()
    const steer = vi.fn(async () => ({ status: "steered" as const }))
    const pending: RuntimeQuestionRequest = {
      kind: "question",
      requestId: "question-1",
      // The gate reads the mounted thread's own id, so the fake answers for it.
      sessionId: "pending",
      questions: [
        {
          header: "Choice",
          prompt: "Choose one",
          options: [{ label: "Proceed" }],
        },
      ],
    }
    const interactions: RuntimeInteractionAdapter = {
      respond: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      getPending: () => pending,
      subscribe: () => () => undefined,
    }
    const model: ChatModelAdapter = {
      run: async () => {
        await new Promise(() => undefined)
        return { content: [] }
      },
    }

    render(
      <PendingInteractionProvider interactions={interactions}>
        <LocalThread
          model={model}
          enableMessageQueue
          composerFeatures={{ steer }}
        />
      </PendingInteractionProvider>
    )

    expect(
      await screen.findByRole("button", {
        name: "Answer the pending question before changing this conversation",
      })
    ).toBeDisabled()

    const input = screen.getByRole("textbox", { name: "Message input" })
    await user.type(input, "Start")
    await user.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop generating" })
      ).toBeVisible()
    )

    await user.type(input, "Follow up")
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(
      await screen.findByRole("region", { name: "Queued messages" })
    ).toBeVisible()
    expect(steer).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("button", { name: "Steer queued message" })
    ).not.toBeInTheDocument()
  })

  it("cancels a streaming response while preserving its partial content", async () => {
    const user = userEvent.setup()
    let providerSignal: AbortSignal | undefined
    const model: ChatModelAdapter = {
      async *run({ abortSignal }) {
        providerSignal = abortSignal
        yield { content: [{ type: "text", text: "Partial response" }] }
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    }

    render(<LocalThread model={model} />)
    await user.type(
      await screen.findByRole("textbox", { name: "Message input" }),
      "Continue"
    )
    await user.click(screen.getByRole("button", { name: "Send message" }))
    expect(await screen.findByText("Partial response")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Stop generating" }))

    await waitFor(() => expect(providerSignal?.aborted).toBe(true))
    expect(screen.getByText("Partial response")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Send message" })
    ).toBeInTheDocument()
  })

  it("offers Queue only for a focused text draft while a response runs", async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => {
      await new Promise(() => undefined)
      return { content: [] }
    })

    render(
      <LocalThread model={{ run }} enableMessageQueue initialMessages={[]} />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "first")
    await user.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())

    expect(
      screen.getByRole("button", { name: "Stop generating" })
    ).toBeVisible()

    await user.type(input, "queue this")
    const queue = screen.getByRole("button", { name: "Queue message" })
    expect(queue).toBeVisible()
    expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull()

    fireEvent.blur(input)
    expect(
      screen.getByRole("button", { name: "Stop generating" })
    ).toBeVisible()

    fireEvent.focus(input)
    await user.click(screen.getByRole("button", { name: "Queue message" }))

    expect(
      await screen.findByRole("region", { name: "Queued messages" })
    ).toBeVisible()
    expect(screen.getByText("queue this")).toBeVisible()
    expect(run).toHaveBeenCalledOnce()
  })

  it.each(["button", "escape"])(
    "routes explicit Stop (%s) through the runtime exactly once",
    async (trigger) => {
      const user = userEvent.setup()
      const stop = vi.fn()
      const model: ChatModelAdapter = {
        async *run({ abortSignal }) {
          yield { content: [{ type: "text", text: "Waiting on native run" }] }
          await new Promise<void>((resolve) =>
            abortSignal.addEventListener(
              "abort",
              () => {
                stop()
                resolve()
              },
              {
                once: true,
              }
            )
          )
        },
      }
      const view = render(<LocalThread model={model} />)
      await user.type(
        screen.getByRole("textbox", { name: "Message input" }),
        "Run"
      )
      await user.click(screen.getByRole("button", { name: "Send message" }))
      await screen.findByText("Waiting on native run")
      expect(stop).not.toHaveBeenCalled()
      if (trigger === "button")
        await user.click(
          screen.getByRole("button", { name: "Stop generating" })
        )
      else {
        const viewport = view.container.querySelector(
          '[data-slot="aui_thread-viewport"]'
        )!
        fireEvent.keyDown(viewport, { key: "Escape", bubbles: true })
      }
      expect(stop).toHaveBeenCalledTimes(1)
      view.unmount()
      expect(stop).toHaveBeenCalledTimes(1)
    }
  )

  it("does not cancel a running response when Escape closes conversation search", async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    const model: ChatModelAdapter = {
      async *run({ abortSignal }) {
        yield { content: [{ type: "text", text: "Waiting on native run" }] }
        await new Promise<void>((resolve) =>
          abortSignal.addEventListener(
            "abort",
            () => {
              stop()
              resolve()
            },
            { once: true }
          )
        )
      },
    }
    render(<LocalThread model={model} />)
    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "Run"
    )
    await user.click(screen.getByRole("button", { name: "Send message" }))
    await screen.findByText("Waiting on native run")

    window.dispatchEvent(new Event("aos:conversation-search"))
    const search = await screen.findByRole("searchbox", {
      name: "Search in conversation",
    })
    fireEvent.keyDown(search, { key: "Escape", bubbles: true })

    expect(search).not.toBeInTheDocument()
    expect(stop).not.toHaveBeenCalled()
  })

  it("cancels a running response when Escape is aimed at the composer", async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    render(<LocalThread model={parkedRun(stop)} initialMessages={[]} />)
    const input = await startParkedRun(user)

    input.focus()
    await user.keyboard("{Escape}")

    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("does not cancel a running response when Escape closes the model selector", async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    render(
      <LocalThread
        model={parkedRun(stop)}
        initialMessages={[]}
        composerFeatures={{
          model: {
            options: [
              { id: "opaque-balanced", label: "Balanced" },
              { id: "opaque-fast", label: "Fast" },
            ],
            selectedId: "opaque-balanced",
            update: async () => undefined,
          },
        }}
      />
    )
    await startParkedRun(user)

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    const roster = await screen.findByRole("listbox")
    await user.keyboard("{Escape}")

    await waitFor(() => expect(roster).not.toBeInTheDocument())
    expect(stop).not.toHaveBeenCalled()
  })

  it("runs a local slash command instead of sending it as a turn", async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => ({ content: [] }))
    const open = vi.fn()
    render(
      <LocalThread
        model={{ run }}
        initialMessages={[]}
        composerFeatures={{
          slashCommands: [{ name: "new", description: "Provider's /new" }],
          localCommands: [
            { name: "new", description: "Start a new Session", run: open },
          ],
        }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })

    await user.type(input, "/ne")
    const menu = await screen.findByRole("listbox", { name: "Slash commands" })
    // The workspace's command shadows the provider's namesake in the menu.
    expect(within(menu).getAllByRole("option")).toHaveLength(1)
    expect(menu).toHaveTextContent("Start a new Session")
    await user.keyboard("{Escape}")

    await user.clear(input)
    await user.type(input, "/New   first prompt ")
    await user.keyboard("{Enter}")

    await waitFor(() => expect(open).toHaveBeenCalledWith("first prompt"))
    expect(run).not.toHaveBeenCalled()
    expect(input).toHaveValue("")
  })

  it("does not cancel a running response when Escape closes the slash command popover", async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    render(
      <LocalThread
        model={parkedRun(stop)}
        initialMessages={[]}
        composerFeatures={{
          slashCommands: [{ name: "review", description: "Review the diff" }],
        }}
      />
    )
    const input = await startParkedRun(user)

    input.focus()
    await user.keyboard("/rev")
    const commands = await screen.findByRole("listbox", {
      name: "Slash commands",
    })
    await user.keyboard("{Escape}")

    await waitFor(() => expect(commands).not.toBeInTheDocument())
    expect(stop).not.toHaveBeenCalled()
  })

  it.each(["Inline overlay", "Portaled overlay"])(
    "does not cancel a running response when Escape comes from an open dialog (%s)",
    async (overlay) => {
      const user = userEvent.setup()
      const stop = vi.fn()
      render(
        <LocalThread
          model={parkedRun(stop)}
          initialMessages={[]}
          composer={OverlayComposer}
        />
      )
      await startParkedRun(user)

      fireEvent.keyDown(screen.getByRole("dialog", { name: overlay }), {
        key: "Escape",
        bubbles: true,
      })

      expect(stop).not.toHaveBeenCalled()
    }
  )

  it("localizes attachment controls and image descriptions through Thread labels", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const labels: Partial<ThreadLabels> = {
      attachments: {
        add: "הוספת קובץ",
        remove: "הסרת קובץ",
        preview: "תצוגה מקדימה של קובץ",
        image: "קובץ תמונה",
        document: "מסמך מצורף",
        file: "קובץ מצורף",
        uploading: "בהעלאה",
        uploadFailed: "ההעלאה נכשלה",
      },
    }

    render(
      <LocalThread
        labels={labels}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )

    await screen.findByText("The reference is ready.")
    expect(
      screen.getByRole("button", { name: "הוספת קובץ" })
    ).toBeInTheDocument()
    await act(() =>
      runtime!.thread.composer.addAttachment({
        name: "wireframe.svg",
        type: "image",
        content: [
          {
            type: "image",
            image:
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          },
        ],
      })
    )
    await user.click(screen.getByRole("button", { name: "קובץ תמונה" }))
    expect(
      await screen.findByRole("dialog", { name: "תצוגה מקדימה של קובץ" })
    ).toBeInTheDocument()
    expect(screen.getByAltText("תצוגה מקדימה של קובץ")).toBeInTheDocument()
  })

  it("renders a sent audio attachment as an inline native player", () => {
    render(
      <LocalThread
        initialMessages={[
          {
            id: "message-audio",
            role: "user",
            content: [{ type: "text", text: "Listen to this" }],
            attachments: [
              {
                id: "attachment-audio",
                type: "file",
                name: "voice-note.mp3",
                contentType: "audio/mpeg",
                status: { type: "complete" },
                content: [
                  {
                    type: "file",
                    data: "data:audio/mpeg;base64,YXVkaW8=",
                    filename: "voice-note.mp3",
                    mimeType: "audio/mpeg",
                  },
                ],
              },
            ],
          },
        ]}
      />
    )

    const player = screen.getByLabelText("Audio attachment: voice-note.mp3")
    expect(player).toBeInstanceOf(HTMLAudioElement)
    expect(player).toHaveAttribute("src", "data:audio/mpeg;base64,YXVkaW8=")
    expect(player).toHaveAttribute("controls")
    expect(player).toHaveAttribute("preload", "metadata")
    expect(player).not.toHaveAttribute("autoplay")
  })

  it("builds a playable data URL for raw base64 media content", () => {
    render(
      <LocalThread
        initialMessages={[
          {
            id: "message-base64-audio",
            role: "user",
            content: [],
            attachments: [
              {
                id: "attachment-base64-audio",
                type: "file",
                name: "raw-audio.wav",
                contentType: "audio/wav",
                status: { type: "complete" },
                content: [
                  {
                    type: "file",
                    data: "YXVkaW8=",
                    filename: "raw-audio.wav",
                    mimeType: "audio/wav",
                  },
                ],
              },
            ],
          },
        ]}
      />
    )

    expect(
      screen.getByLabelText("Audio attachment: raw-audio.wav")
    ).toHaveAttribute("src", "data:audio/wav;base64,YXVkaW8=")
  })

  it("preserves a blob URL used by a sent media attachment", () => {
    render(
      <LocalThread
        initialMessages={[
          {
            id: "message-blob-audio",
            role: "user",
            content: [],
            attachments: [
              {
                id: "attachment-blob-audio",
                type: "file",
                name: "local-note.webm",
                contentType: "audio/webm",
                status: { type: "complete" },
                content: [
                  {
                    type: "file",
                    data: "blob:https://aos.test/media-1",
                    filename: "local-note.webm",
                    mimeType: "audio/webm",
                    sourceType: "url",
                  },
                ],
              },
            ],
          },
        ]}
      />
    )

    expect(
      screen.getByLabelText("Audio attachment: local-note.webm")
    ).toHaveAttribute("src", "blob:https://aos.test/media-1")
  })

  it("renders a URL-backed sent video with a localized accessible name", () => {
    render(
      <LocalThread
        labels={{ attachments: { video: "וידאו מצורף" } }}
        initialMessages={[
          {
            id: "message-video",
            role: "user",
            content: [{ type: "text", text: "Watch this" }],
            attachments: [
              {
                id: "attachment-video",
                type: "file",
                name: "walkthrough.mp4",
                contentType: "video/mp4",
                status: { type: "complete" },
                content: [
                  {
                    type: "file",
                    data: "https://media.example.test/walkthrough.mp4",
                    filename: "walkthrough.mp4",
                    mimeType: "video/mp4",
                    sourceType: "url",
                  },
                ],
              },
            ],
          },
        ]}
      />
    )

    const player = screen.getByLabelText("וידאו מצורף: walkthrough.mp4")
    expect(player).toBeInstanceOf(HTMLVideoElement)
    expect(player).toHaveAttribute(
      "src",
      "https://media.example.test/walkthrough.mp4"
    )
    expect(player).toHaveAttribute("controls")
    expect(player).toHaveAttribute("preload", "metadata")
    expect(player).not.toHaveAttribute("autoplay")
  })

  it("keeps a media attachment tile when provider history has no playable source", () => {
    render(
      <LocalThread
        initialMessages={[
          {
            id: "message-metadata-only-video",
            role: "user",
            content: [],
            attachments: [
              {
                id: "attachment-metadata-only-video",
                type: "file",
                name: "archived.mov",
                contentType: "video/quicktime",
                status: { type: "complete" },
                content: [],
              },
            ],
          },
        ]}
      />
    )

    expect(
      screen.getByRole("button", { name: "Video attachment" })
    ).toBeVisible()
    expect(document.querySelector("video")).toBeNull()
  })

  it("falls back to a media tile for an unsafe URL source", () => {
    render(
      <LocalThread
        initialMessages={[
          {
            id: "message-unsafe-audio",
            role: "user",
            content: [],
            attachments: [
              {
                id: "attachment-unsafe-audio",
                type: "file",
                name: "unsafe.mp3",
                contentType: "audio/mpeg",
                status: { type: "complete" },
                content: [
                  {
                    type: "file",
                    data: "javascript:alert(1)",
                    filename: "unsafe.mp3",
                    mimeType: "audio/mpeg",
                    sourceType: "url",
                  },
                ],
              },
            ],
          },
        ]}
      />
    )

    expect(
      screen.getByRole("button", { name: "Audio attachment" })
    ).toBeVisible()
    expect(document.querySelector("audio")).toBeNull()
  })

  it("keeps playable audio compact while it is still in the composer", async () => {
    let runtime: AssistantRuntime | undefined
    render(
      <LocalThread
        initialMessages={[]}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )

    await act(() =>
      runtime!.thread.composer.addAttachment({
        name: "draft-note.mp3",
        type: "file",
        contentType: "audio/mpeg",
        content: [
          {
            type: "file",
            data: "data:audio/mpeg;base64,YXVkaW8=",
            filename: "draft-note.mp3",
            mimeType: "audio/mpeg",
          },
        ],
      })
    )

    expect(
      screen.getByRole("button", { name: "Audio attachment" })
    ).toBeVisible()
    expect(document.querySelector("audio")).toBeNull()
    expect(
      screen.getByRole("button", { name: "Remove attachment" })
    ).toBeVisible()
  })

  it("returns focus to the composer after an attachment is added", async () => {
    let runtime: AssistantRuntime | undefined
    render(
      <LocalThread
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = screen.getByRole("textbox", { name: "Message input" })
    screen.getByRole("button", { name: "Add attachment" }).focus()

    await act(() =>
      runtime!.thread.composer.addAttachment({
        name: "notes.txt",
        type: "file",
        content: [
          {
            type: "file",
            data: "data:text/plain;base64,aGVsbG8=",
            filename: "notes.txt",
            mimeType: "text/plain",
          },
        ],
      })
    )

    await waitFor(() => expect(input).toHaveFocus())
  })

  it("offers reasoning effort only for a model whose provider reports it", async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => undefined)
    render(
      <LocalThread
        initialMessages={[]}
        composerFeatures={{
          model: {
            options: [
              {
                id: "opaque-balanced",
                label: "Balanced",
                efforts: [{ id: "low" }, { id: "high" }],
              },
              { id: "opaque-fast", label: "Fast" },
            ],
            selectedId: "opaque-balanced",
            effortId: "low",
            update,
          },
        }}
      />
    )

    // One control owns both halves of a model choice.
    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    const effort = await screen.findByRole("slider", { name: "Thinking" })
    effort.focus()
    await user.keyboard("{ArrowUp}")

    expect(update).toHaveBeenCalledWith({ effortId: "high" })

    await user.click(await screen.findByText("Fast"))
    expect(update).toHaveBeenLastCalledWith({ selectedId: "opaque-fast" })
  })

  it.each([
    ["a ladder id keeps its localized name", "high", "High"],
    ["an unknown id shows its provider's name", "turbo", "Turbo"],
    ["an unnamed unknown id shows the id", "burst", "burst"],
  ])("names the effort: %s", async (_label, effortId, name) => {
    const user = userEvent.setup()
    render(
      <LocalThread
        initialMessages={[]}
        composerFeatures={{
          model: {
            options: [
              {
                id: "opaque-balanced",
                label: "Balanced",
                efforts: [
                  { id: "high", name: "Deep" },
                  { id: "turbo", name: "Turbo" },
                  { id: "burst" },
                ],
              },
            ],
            selectedId: "opaque-balanced",
            effortId,
            update: async () => undefined,
          },
        }}
      />
    )

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    expect(
      await screen.findByRole("slider", { name: "Thinking" })
    ).toHaveAttribute("aria-valuetext", name)
  })

  it("hides reasoning effort when the provider reports none", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        initialMessages={[]}
        composerFeatures={{
          model: {
            options: [{ id: "opaque-fast", label: "Fast" }],
            selectedId: "opaque-fast",
            update: async () => undefined,
          },
        }}
      />
    )

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    expect(await screen.findByRole("listbox")).toBeVisible()
    expect(screen.queryByRole("slider", { name: "Thinking" })).toBeNull()
  })

  it("shows the model a pending switch is settling and announces it", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        initialMessages={[]}
        composerFeatures={{
          model: {
            options: [
              { id: "opaque-balanced", label: "Balanced" },
              { id: "opaque-fast", label: "Fast" },
            ],
            selectedId: "opaque-fast",
            selection: {
              status: "pending",
              target: { selectedId: "opaque-fast" },
            },
            update: async () => undefined,
          },
        }}
      />
    )

    const trigger = screen.getByRole("combobox", { name: "Choose model" })
    expect(trigger).toHaveTextContent("Fast")
    expect(trigger).toHaveAttribute("aria-busy", "true")

    await user.click(trigger)
    expect(await screen.findByText("Switching model…")).toBeVisible()
  })

  it("retries the model update that failed", async () => {
    const user = userEvent.setup()
    const retry = vi.fn(async () => undefined)
    render(
      <LocalThread
        initialMessages={[]}
        composerFeatures={{
          model: {
            options: [
              { id: "opaque-balanced", label: "Balanced" },
              { id: "opaque-fast", label: "Fast" },
            ],
            selectedId: "opaque-balanced",
            selection: {
              status: "error",
              target: { selectedId: "opaque-fast" },
              error: "The provider rejected the model",
            },
            update: async () => undefined,
            retry,
          },
        }}
      />
    )

    const trigger = screen.getByRole("combobox", { name: "Choose model" })
    // A failed switch leaves the Session on the model it is still running.
    expect(trigger).toHaveTextContent("Balanced")
    await user.click(trigger)
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The provider rejected the model"
    )

    await user.click(
      screen.getByRole("button", { name: "Retry model selection" })
    )
    expect(retry).toHaveBeenCalledOnce()
  })

  it("omits categories the runtime did not provide", () => {
    render(
      <LocalThread
        initialMessages={[]}
        composerFeatures={{
          context: {
            usage: { system: 0, tools: 0, messages: 36, total: 272 },
            segments: [],
          },
        }}
      />
    )

    expect(screen.getByText("36k / 272k")).toBeInTheDocument()
    expect(screen.queryByText("System")).toBeNull()
    expect(screen.queryByText("Tools")).toBeNull()
    expect(screen.queryByText("Messages")).toBeNull()
  })

  it("uses localized accessible labels for composer model and context controls", () => {
    render(
      <LocalThread
        initialMessages={[]}
        labels={{
          modelSelector: "בחירת מודל",
          contextUsage: "שימוש בהקשר",
        }}
        composerFeatures={{
          model: {
            options: [{ id: "opaque-balanced", label: "מאוזן" }],
            selectedId: "opaque-balanced",
            update: async () => undefined,
          },
          context: {
            usage: { system: 0, tools: 0, messages: 1, total: 4 },
          },
        }}
      />
    )

    expect(
      screen.getByRole("combobox", { name: "בחירת מודל" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "שימוש בהקשר" })
    ).toBeInTheDocument()
  })

  it("opens the Hebrew model selector with RTL popup semantics", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        initialMessages={[]}
        direction="rtl"
        labels={{ modelSelector: "בחירת מודל" }}
        composerFeatures={{
          model: {
            options: [
              { id: "opaque-balanced", label: "מאוזן" },
              { id: "opaque-fast", label: "מהיר" },
            ],
            selectedId: "opaque-balanced",
            update: async () => undefined,
          },
        }}
      />
    )

    await user.click(screen.getByRole("combobox", { name: "בחירת מודל" }))

    expect(await screen.findByRole("listbox")).toBeVisible()
    expect(
      (await screen.findByRole("listbox")).closest("[dir='rtl']")
    ).not.toBeNull()
  })

  it("preserves a complete attachment when editing only the message text", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn<ChatModelAdapter["run"]>().mockResolvedValue({
      content: [{ type: "text", text: "Updated" }],
    })
    const view = render(
      <LocalThread
        model={{ run }}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    await screen.findByText("The reference is ready.")

    act(() => {
      runtime!.thread.getMessageById("message-user").composer.beginEdit()
    })
    const editor = view.container.querySelector<HTMLTextAreaElement>(
      ".aui-edit-composer-input"
    )
    expect(editor).not.toBeNull()
    await user.clear(editor!)
    await user.type(editor!, "Review this image carefully")
    await user.click(screen.getByRole("button", { name: "Update" }))

    await waitFor(() => {
      const editedBranch = runtime!.thread
        .getState()
        .messages.findLast(
          (message) =>
            message.role === "user" &&
            messageText(message) === "Review this image carefully"
        )
      if (!editedBranch?.attachments) {
        throw new Error("Expected the edited branch with its attachments")
      }
      expect(editedBranch.attachments).toHaveLength(1)
      expect(editedBranch.attachments[0]).toMatchObject({
        type: "image",
        name: "reference.svg",
        status: { type: "complete" },
        content: [
          {
            type: "image",
            image:
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          },
        ],
      })
    })
    expect(run).toHaveBeenCalledTimes(1)
    const submittedUserMessage = run.mock.calls[0]?.[0].messages.findLast(
      (message) => message.role === "user"
    )
    expect(messageText(submittedUserMessage!)).toBe(
      "Review this image carefully"
    )
    expect(submittedUserMessage?.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          name: "reference.svg",
          status: { type: "complete" },
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "image",
              image:
                "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
            }),
          ]),
        }),
      ])
    )
  })

  it("uses Shift+Enter for newlines and plain Enter to submit desktop message edits", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn<ChatModelAdapter["run"]>().mockResolvedValue({
      content: [{ type: "text", text: "Updated" }],
    })
    const view = render(
      <LocalThread
        model={{ run }}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    await screen.findByText("The reference is ready.")

    act(() => {
      runtime!.thread.getMessageById("message-user").composer.beginEdit()
    })
    const editor = view.container.querySelector<HTMLTextAreaElement>(
      ".aui-edit-composer-input"
    )
    expect(editor).not.toBeNull()
    expect(editor).toHaveAttribute("enterkeyhint", "enter")

    await user.clear(editor!)
    await user.type(editor!, "First line")
    await user.keyboard("{Shift>}{Enter}{/Shift}")
    await user.type(editor!, "Second line")

    expect(editor).toHaveValue("First line\nSecond line")
    expect(run).not.toHaveBeenCalled()

    await user.keyboard("{Enter}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
  })

  it("keeps touch-primary message edits multiline until Ctrl+Enter", async () => {
    setTouchPrimary(true)
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn<ChatModelAdapter["run"]>().mockResolvedValue({
      content: [{ type: "text", text: "Updated" }],
    })
    const view = render(
      <LocalThread
        model={{ run }}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    await screen.findByText("The reference is ready.")

    act(() => {
      runtime!.thread.getMessageById("message-user").composer.beginEdit()
    })
    const editor = view.container.querySelector<HTMLTextAreaElement>(
      ".aui-edit-composer-input"
    )
    expect(editor).not.toBeNull()

    await user.clear(editor!)
    await user.type(editor!, "First line")
    await user.keyboard("{Enter}")
    await user.type(editor!, "Second line")

    expect(editor).toHaveValue("First line\nSecond line")
    expect(run).not.toHaveBeenCalled()

    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
  })

  it("opens current-session history search with Ctrl+R without sending the draft", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Done" }],
    }))

    render(
      <LocalThread
        model={{ run }}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = (await screen.findByRole("textbox", {
      name: "Message input",
    })) as HTMLTextAreaElement
    await user.type(input, "unsent draft")
    await act(() =>
      runtime!.thread.composer.addAttachment({
        name: "search-context.txt",
        type: "file",
        content: [{ type: "text", text: "context" }],
      })
    )
    const attachmentIds = runtime!.thread.composer
      .getState()
      .attachments.map((attachment) => attachment.id)
    await user.keyboard("{Meta>}r{/Meta}")
    expect(
      screen.queryByRole("dialog", { name: "Search conversation history" })
    ).toBeNull()
    expect(input).toHaveValue("unsent draftr")
    await user.keyboard("{Backspace}")
    input.setSelectionRange(2, 6)
    await user.keyboard("{Control>}r{/Control}")

    expect(
      await screen.findByRole("dialog", { name: "Search conversation history" })
    ).toBeVisible()
    await user.keyboard("{Escape}")
    expect(input).toHaveValue("unsent draft")
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(6)
    expect(
      runtime!.thread.composer
        .getState()
        .attachments.map((attachment) => attachment.id)
    ).toEqual(attachmentIds)
    expect(run).not.toHaveBeenCalled()
  })

  it("uses ArrowDown then Enter or Tab to load history without submitting", async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Done" }],
    }))
    const messages: readonly ThreadMessageLike[] = [
      {
        id: "history-older",
        role: "user",
        content: [{ type: "text", text: "Older request" }],
      },
      {
        id: "history-older-answer",
        role: "assistant",
        content: [{ type: "text", text: "Older answer" }],
      },
      {
        id: "history-newer",
        role: "user",
        content: [{ type: "text", text: "Newer request" }],
      },
      {
        id: "history-newer-answer",
        role: "assistant",
        content: [{ type: "text", text: "Newer answer" }],
      },
    ]

    render(<LocalThread model={{ run }} initialMessages={messages} />)
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.click(input)
    await user.keyboard("{Control>}r{/Control}")

    const search = await screen.findByRole("textbox", {
      name: "Filter sent messages…",
    })
    expect(
      screen.getByRole("option", { name: "Newer request" })
    ).toHaveAttribute("aria-selected", "true")
    await user.keyboard("{ArrowDown}")
    expect(
      screen.getByRole("option", { name: "Older request" })
    ).toHaveAttribute("aria-selected", "true")
    await user.keyboard("{Enter}")
    expect(input).toHaveValue("Older request")
    expect(run).not.toHaveBeenCalled()

    await user.keyboard("{Control>}r{/Control}")
    await screen.findByRole("textbox", { name: "Filter sent messages…" })
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{Tab}")
    expect(input).toHaveValue("Older request")
    expect(search).not.toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()
  })

  it("enters history from a nonempty draft and restores its exact text selection", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        initialMessages={[
          {
            id: "history-entry",
            role: "user",
            content: [{ type: "text", text: "Previous request" }],
          },
        ]}
      />
    )
    const input = (await screen.findByRole("textbox", {
      name: "Message input",
    })) as HTMLTextAreaElement
    await user.type(input, "present draft")
    input.setSelectionRange(3, 3)
    fireEvent.keyDown(input, { key: "ArrowUp" })
    await waitFor(() => expect(input).toHaveValue("Previous request"))

    fireEvent.keyDown(input, { key: "ArrowDown" })
    await waitFor(() => expect(input).toHaveValue("present draft"))
    expect(input.selectionStart).toBe(3)
    expect(input.selectionEnd).toBe(3)
  })

  it("loads a current-session history entry without sending it", async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Done" }],
    }))

    render(<LocalThread model={{ run }} />)
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.click(input)
    await user.keyboard("{Control>}r{/Control}")
    await user.click(
      await screen.findByRole("option", { name: "Review this image" })
    )

    expect(input).toHaveValue("Review this image")
    expect(run).not.toHaveBeenCalled()
  })

  it("queues busy Ctrl+Enter exactly once in the queue lane", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    let release: (() => void) | undefined
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { content: [{ type: "text" as const, text: "Done" }] }
    })

    render(
      <LocalThread
        model={{ run }}
        enableMessageQueue
        initialMessages={[]}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    await waitFor(() =>
      expect(runtime?.thread.getState().capabilities.queue).toBe(true)
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "first")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    await user.type(input, "second")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Queued messages" })
      ).toBeVisible()
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(screen.getByText("second")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Steer queued message" })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Remove queued message" })
    ).toBeVisible()

    await user.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Queued messages" })
      ).toBeVisible()
    )
    expect(run).toHaveBeenCalledTimes(1)

    await act(async () => release?.())
    expect(
      screen.queryByRole("button", { name: "Resume queued message" })
    ).not.toBeInTheDocument()
    await user.type(input, "third")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(screen.getByText("second")).toBeInTheDocument()
    await act(async () => release?.())
  })

  it("steers the targeted queued row and leaves the remaining FIFO order intact", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn(async () => {
      await new Promise(() => undefined)
      return { content: [] }
    })
    const steer = vi.fn(async () => ({ status: "steered" as const }))
    render(
      <LocalThread
        model={{ run }}
        enableMessageQueue
        initialMessages={[]}
        composerFeatures={{ steer }}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "running")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    await user.type(input, "steer this")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await user.type(input, "keep this")
    await user.keyboard("{Control>}{Enter}{/Control}")

    const rows = await screen.findAllByRole("listitem")
    expect(rows).toHaveLength(2)
    await user.click(
      within(rows[0]!).getByRole("button", { name: "Steer queued message" })
    )

    await waitFor(() => expect(steer).toHaveBeenCalledOnce())
    expect(steer).toHaveBeenCalledWith({
      requestId: expect.any(String),
      text: "steer this",
    })
    await waitFor(() =>
      expect(runtime?.thread.composer.getState().queue).toHaveLength(1)
    )
    expect(screen.queryByText("steer this")).not.toBeInTheDocument()
    expect(screen.getByText("keep this")).toBeVisible()
  })

  it("disables a queued row while steering and preserves it after a definite rejection", async () => {
    const user = userEvent.setup()
    let rejectSteer: ((error: Error) => void) | undefined
    const run = vi.fn(async () => {
      await new Promise(() => undefined)
      return { content: [] }
    })
    const steer = vi.fn(
      () =>
        new Promise<{ status: "steered" }>((_resolve, reject) => {
          rejectSteer = reject
        })
    )
    render(
      <LocalThread
        model={{ run }}
        enableMessageQueue
        initialMessages={[]}
        composerFeatures={{ steer }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "running")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    await user.type(input, "keep on failure")
    await user.keyboard("{Control>}{Enter}{/Control}")

    const steerButton = await screen.findByRole("button", {
      name: "Steer queued message",
    })
    const removeButton = screen.getByRole("button", {
      name: "Remove queued message",
    })
    await user.click(steerButton)
    expect(steerButton).toBeDisabled()
    expect(removeButton).toBeDisabled()
    expect(screen.getByText("Steering queued message")).toBeInTheDocument()

    await act(async () => rejectSteer?.(new Error("offline")))
    await waitFor(() => expect(steerButton).toBeEnabled())
    expect(removeButton).toBeEnabled()
    expect(screen.getByText("keep on failure")).toBeVisible()
    expect(screen.getAllByText("Could not steer").length).toBeGreaterThan(0)
  })

  it("clears a queued row once its correction lands as a user turn", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn(async () => {
      await new Promise(() => undefined)
      return { content: [] }
    })
    let steered: string | undefined
    const steer = vi.fn(async ({ requestId }: { requestId: string }) => {
      steered = requestId
      await new Promise(() => undefined)
      return { status: "steered" as const }
    })
    render(
      <LocalThread
        model={{ run }}
        enableMessageQueue
        initialMessages={[]}
        composerFeatures={{ steer }}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "running")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    await user.type(input, "correct now")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await user.click(
      await screen.findByRole("button", { name: "Steer queued message" })
    )
    await waitFor(() => expect(steered).toBeTypeOf("string"))

    act(() => {
      runtime?.thread.reset([
        {
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "running" }],
        },
        {
          id: steerMessageId(steered!),
          role: "user",
          content: [{ type: "text", text: "correct now" }],
        },
      ])
    })

    await waitFor(() =>
      expect(runtime?.thread.composer.getState().queue).toHaveLength(0)
    )
    expect(
      screen.queryByRole("region", { name: "Queued messages" })
    ).not.toBeInTheDocument()
  })

  it("turns an uncertain queued steer into a non-sending receipt", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn(async () => {
      await new Promise(() => undefined)
      return { content: [] }
    })
    const steer = vi.fn(async () => {
      throw { code: "uncertain_mutation" }
    })
    render(
      <LocalThread
        model={{ run }}
        enableMessageQueue
        initialMessages={[]}
        composerFeatures={{ steer }}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "running")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    await user.type(input, "maybe delivered")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await user.click(
      await screen.findByRole("button", { name: "Steer queued message" })
    )

    expect(await screen.findByText("Delivery unconfirmed")).toBeVisible()
    expect(screen.getByText("maybe delivered")).toBeVisible()
    expect(
      screen.queryByRole("region", { name: "Queued messages" })
    ).not.toBeInTheDocument()
    expect(run).toHaveBeenCalledOnce()

    act(() => {
      runtime?.thread.reset([
        {
          id: "durable-steering-message",
          role: "user",
          content: [{ type: "text", text: "maybe delivered" }],
        },
      ])
    })
    await waitFor(() =>
      expect(screen.queryByText("Delivery unconfirmed")).toBeNull()
    )
    expect(screen.getByText("maybe delivered")).toBeVisible()
  })

  it("uses the busy steering shortcut without adding an assistant-ui queue item", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn(async () => {
      await new Promise(() => undefined)
      return { content: [] }
    })
    const steer = vi.fn(async () => ({ status: "steered" as const }))
    render(
      <LocalThread
        model={{ run }}
        enableMessageQueue
        initialMessages={[]}
        composerFeatures={{ steer }}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "running")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    await user.type(input, "correct now")
    fireEvent.keyDown(input, {
      key: "Enter",
      ctrlKey: true,
      shiftKey: true,
    })

    await waitFor(() => expect(steer).toHaveBeenCalledOnce())
    expect(steer).toHaveBeenCalledWith({
      requestId: expect.any(String),
      text: "correct now",
    })
    expect(runtime?.thread.composer.getState().queue).toHaveLength(0)
    await waitFor(() => expect(input).toHaveValue(""))
  })

  it("cancels from the transcript while leaving a queued follow-up parked", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn(async function* ({
      abortSignal,
    }: {
      abortSignal: AbortSignal
    }) {
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true })
      })
      yield { content: [{ type: "text" as const, text: "Done" }] }
    })

    render(
      <LocalThread
        model={{ run }}
        enableMessageQueue
        initialMessages={[]}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    await waitFor(() =>
      expect(runtime?.thread.getState().capabilities.queue).toBe(true)
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "first")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await user.type(input, "park me")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await screen.findByText("park me")

    const viewport = document.querySelector('[data-slot="aui_thread-viewport"]')
    expect(viewport).toBeInTheDocument()
    if (!viewport) throw new Error("Thread viewport not found")
    fireEvent.keyDown(viewport, { key: "Escape", keyCode: 0, bubbles: true })
    await waitFor(() =>
      expect(runtime?.thread.getState().isRunning).toBe(false)
    )
    expect(runtime?.thread.composer.getState().queue).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("clears a draft only after two idle Escape presses and restores it with ArrowUp", async () => {
    const user = userEvent.setup()
    render(<LocalThread />)
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "recover me")
    await user.keyboard("{Escape}")
    expect(input).toHaveValue("recover me")

    await user.keyboard("{Escape}")
    await waitFor(() => expect(input).toHaveValue(""))

    await user.keyboard("{ArrowUp}")
    await waitFor(() => expect(input).toHaveValue("recover me"))
  })

  it("does not restore a cleared draft after switching sessions", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    render(
      <LocalThread
        initialMessages={[]}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "session one draft")
    await user.keyboard("{Escape}")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(input).toHaveValue(""))

    await act(async () => {
      await runtime!.threads.switchToNewThread()
    })
    await waitFor(() => expect(input).toHaveValue(""))
    await user.keyboard("{ArrowUp}")
    expect(input).toHaveValue("")
  })

  it("isolates history search state when switching sessions", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    render(
      <MultiSessionThread
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "session one draft")
    await user.keyboard("{Control>}r{/Control}")
    expect(
      await screen.findByRole("dialog", { name: "Search conversation history" })
    ).toBeVisible()

    await act(async () => {
      await runtime!.threads.switchToThread("session-two")
    })
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Search conversation history" })
      ).toBeNull()
    )
    expect(input).toHaveValue("")

    await user.click(input)
    fireEvent.keyDown(input, { key: "ArrowUp" })
    await waitFor(() => expect(input).toHaveValue("Session two history"))
  })

  it("does not consume keyCode 229 in the composer or history search", async () => {
    const user = userEvent.setup()
    render(<LocalThread />)
    const input = (await screen.findByRole("textbox", {
      name: "Message input",
    })) as HTMLTextAreaElement

    const composerEvent = new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(composerEvent)
    expect(composerEvent.defaultPrevented).toBe(false)

    await user.click(input)
    await user.keyboard("{Control>}r{/Control}")
    const search = await screen.findByRole("textbox", {
      name: "Filter sent messages…",
    })
    const searchEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    })
    search.dispatchEvent(searchEvent)
    expect(searchEvent.defaultPrevented).toBe(false)
    expect(
      screen.getByRole("dialog", { name: "Search conversation history" })
    ).toBeInTheDocument()
  })

  it("restores a pending file attachment after clear and undo", async () => {
    const user = userEvent.setup()
    const file = new File(["pending"], "pending.txt", { type: "text/plain" })
    const pending = {
      id: "pending-file",
      type: "file" as const,
      name: file.name,
      contentType: file.type,
      file,
      status: {
        type: "running" as const,
        reason: "uploading" as const,
        progress: 0,
      },
    }
    const attachmentAdapter: AttachmentAdapter = {
      accept: "text/*",
      add: vi.fn(async () => pending),
      remove: vi.fn(async () => undefined),
      send: vi.fn(async () => ({
        ...pending,
        status: { type: "complete" as const },
        content: [{ type: "text" as const, text: "pending" }],
      })),
    }
    let runtime: AssistantRuntime | undefined
    render(
      <LocalThread
        initialMessages={[]}
        attachmentAdapter={attachmentAdapter}
        exposeRuntime={(value) => {
          runtime = value
        }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "recover attachment")
    await act(() => runtime!.thread.composer.addAttachment(file))
    expect(runtime!.thread.composer.getState().attachments).toHaveLength(1)

    await user.keyboard("{Escape}")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(input).toHaveValue(""))
    await user.keyboard("{ArrowUp}")
    await waitFor(() => expect(input).toHaveValue("recover attachment"))
    await waitFor(() =>
      expect(runtime!.thread.composer.getState().attachments).toHaveLength(1)
    )
    expect(runtime!.thread.composer.getState().attachments[0]?.id).toBe(
      "pending-file"
    )
  })

  it("uses a localized accessible name for queued messages", async () => {
    const user = userEvent.setup()
    const run = vi.fn(async function* ({
      abortSignal,
    }: {
      abortSignal: AbortSignal
    }) {
      yield { content: [] }
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true })
      })
    })
    const model: ChatModelAdapter = { run }
    render(
      <LocalThread
        initialMessages={[]}
        enableMessageQueue
        model={model}
        labels={{ queuedMessages: "הודעות בתור" }}
      />
    )
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "first")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await user.type(input, "queued")
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(
      await screen.findByRole("region", { name: "הודעות בתור" })
    ).toBeVisible()
  })

  it("opens history on a double Escape from an empty composer", async () => {
    const user = userEvent.setup()
    render(<LocalThread />)
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.click(input)
    await user.keyboard("{Escape}")
    await user.keyboard("{Escape}")

    expect(
      await screen.findByRole("dialog", { name: "Search conversation history" })
    ).toBeVisible()
    await user.keyboard("{Escape}")
    expect(input).toHaveValue("")
  })

  it("disarms double Escape recovery when input changes or focus leaves", async () => {
    const user = userEvent.setup()
    render(<LocalThread initialMessages={[]} />)
    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "recover")
    await user.keyboard("{Escape}")
    await user.type(input, "ed")
    await user.keyboard("{Escape}")
    expect(input).toHaveValue("recovered")

    input.blur()
    input.focus()
    await user.keyboard("{Escape}")
    const consumedEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })
    consumedEscape.preventDefault()
    input.dispatchEvent(consumedEscape)
    await user.keyboard("{Escape}")
    expect(input).toHaveValue("recovered")
  })
})

describe("failed turn presentation", () => {
  // A live run reports the normalized failure shape; a replayed turn carries the
  // durable description the protocol stores as a plain string.
  const failedTurn = (
    error: { code?: string; message?: string } | string | undefined
  ): readonly ThreadMessageLike[] => [
    { id: "u1", role: "user", content: [{ type: "text", text: "Summarize" }] },
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "Half an answer" }],
      status: { type: "incomplete", reason: "error", error },
    },
  ]

  it("reads a normalized code as localized AOS copy, not the Agent's words", () => {
    render(
      <LocalThread
        initialMessages={failedTurn({ code: "AOS_PROVIDER_RUN_FAILED" })}
      />
    )

    expect(
      screen.getByRole("alert", {
        name: `AOS ${en.runErrors.AOS_PROVIDER_RUN_FAILED}`,
      })
    ).toBeVisible()
  })

  it("keeps the provider's own description for a code this build cannot know", () => {
    render(
      <LocalThread
        initialMessages={failedTurn({
          code: "AOS_UNKNOWN_TO_THIS_BUILD",
          message: "The upstream model returned 503.",
        })}
      />
    )

    const notice = screen.getByRole("alert", {
      name: "AOS The upstream model returned 503.",
    })
    expect(notice).toBeVisible()
    // The description is already the headline, so it is not repeated as detail.
    expect(
      within(notice).getAllByText("The upstream model returned 503.")
    ).toHaveLength(1)
  })

  it("shows the provider's description beside a localized headline", () => {
    render(
      <LocalThread
        initialMessages={failedTurn({
          code: "AOS_SESSION_BUSY",
          message: "run 9f2 is still streaming",
        })}
      />
    )

    const notice = screen.getByRole("alert", {
      name: `AOS ${en.runErrors.AOS_SESSION_BUSY}`,
    })
    expect(within(notice).getByText("run 9f2 is still streaming")).toBeVisible()
  })

  it("never renders a failure object as text", () => {
    render(
      <LocalThread
        initialMessages={failedTurn({ code: "AOS_PROVIDER_RUN_FAILED" })}
      />
    )

    expect(screen.queryByText(/\[object Object\]/u)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain("[object Object]")
  })

  it("falls back to generic copy when nothing named the failure", () => {
    render(<LocalThread initialMessages={failedTurn(undefined)} />)

    expect(
      screen.getByRole("alert", { name: `AOS ${en.turnFailed}` })
    ).toBeVisible()
  })

  it("reads a replayed string failure as the provider's description", () => {
    render(
      <LocalThread
        initialMessages={failedTurn("The provider rejected this turn.")}
      />
    )

    expect(
      screen.getByRole("alert", {
        name: "AOS The provider rejected this turn.",
      })
    ).toBeVisible()
  })

  it("speaks Hebrew for the same normalized code", () => {
    render(
      <LocalThread
        locale="he"
        direction="rtl"
        initialMessages={failedTurn({ code: "AOS_PROVIDER_RUN_FAILED" })}
      />
    )

    const notice = screen.getByRole("alert", {
      name: `AOS ${he.runErrors.AOS_PROVIDER_RUN_FAILED}`,
    })
    expect(notice).toHaveAttribute("dir", "rtl")
    expect(document.body.textContent).not.toContain("[object Object]")
  })

  it("keeps the retry affordance out of the notice", () => {
    render(
      <LocalThread
        initialMessages={failedTurn({ code: "AOS_PROVIDER_RUN_FAILED" })}
      />
    )

    expect(
      within(screen.getByRole("alert")).queryByRole("button")
    ).not.toBeInTheDocument()
  })
})

/** A right click lands wherever the reader pressed, inside the message. */
async function openMessageMenu(text: string) {
  fireEvent.contextMenu(await screen.findByText(text), {
    clientX: 24,
    clientY: 48,
  })
  return screen.findByRole("menu")
}

describe("message context menu", () => {
  it("offers the assistant turn's own actions on a right click", async () => {
    render(<LocalThread />)

    const menu = await openMessageMenu("The reference is ready.")

    expect(within(menu).getByRole("menuitem", { name: "Copy" })).toBeVisible()
    expect(
      within(menu).getByRole("menuitem", { name: "Refresh" })
    ).toBeVisible()
    expect(
      within(menu).getByRole("menuitem", { name: "Export as Markdown" })
    ).toBeVisible()
    expect(within(menu).queryByRole("menuitem", { name: "Edit" })).toBeNull()
    expect(
      within(menu).queryByRole("menuitem", { name: "Select text" })
    ).toBeNull()
  })

  it("offers the user turn's own actions on a right click", async () => {
    render(<LocalThread />)

    const menu = await openMessageMenu("Review this image")

    expect(within(menu).getByRole("menuitem", { name: "Copy" })).toBeVisible()
    expect(within(menu).getByRole("menuitem", { name: "Edit" })).toBeVisible()
    expect(within(menu).queryByRole("menuitem", { name: "Refresh" })).toBeNull()
  })

  it("drops retry and edit where the provider cannot rewind", async () => {
    const user = userEvent.setup()
    render(<LocalThread messageRewind={false} />)

    const assistant = await openMessageMenu("The reference is ready.")
    expect(
      within(assistant).getByRole("menuitem", { name: "Copy" })
    ).toBeVisible()
    expect(
      within(assistant).queryByRole("menuitem", { name: "Refresh" })
    ).toBeNull()

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())

    const userTurn = await openMessageMenu("Review this image")
    expect(
      within(userTurn).getByRole("menuitem", { name: "Copy" })
    ).toBeVisible()
    expect(
      within(userTurn).queryByRole("menuitem", { name: "Edit" })
    ).toBeNull()
  })

  it("carries the source user turn in the retry run config", async () => {
    const user = userEvent.setup()
    const runConfig = vi.fn((sourceUserId: string) => ({
      custom: { "aos.rewindSourceId": sourceUserId },
    }))
    const run = vi.fn(async () => ({ content: [] }))

    render(<LocalThread messageRewind={{ runConfig }} model={{ run }} />)
    const menu = await openMessageMenu("The reference is ready.")
    await user.click(within(menu).getByRole("menuitem", { name: "Refresh" }))

    expect(runConfig).toHaveBeenCalledExactlyOnceWith("message-user")
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          runConfig: { custom: { "aos.rewindSourceId": "message-user" } },
        })
      )
    )
  })

  it("opens the edit composer from the menu", async () => {
    const user = userEvent.setup()
    render(<LocalThread />)

    const menu = await openMessageMenu("Review this image")
    await user.click(within(menu).getByRole("menuitem", { name: "Edit" }))

    expect(
      await screen.findByRole("button", { name: "Update" })
    ).toBeInTheDocument()
  })

  it("names the pending question on the action it holds back", async () => {
    const pending: RuntimeQuestionRequest = {
      kind: "question",
      requestId: "question-1",
      sessionId: "pending",
      questions: [
        {
          header: "Choice",
          prompt: "Choose one",
          options: [{ label: "Proceed" }],
        },
      ],
    }
    const interactions: RuntimeInteractionAdapter = {
      respond: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      getPending: () => pending,
      subscribe: () => () => undefined,
    }

    render(
      <PendingInteractionProvider interactions={interactions}>
        <LocalThread />
      </PendingInteractionProvider>
    )
    const menu = await openMessageMenu("The reference is ready.")

    // Base UI keeps a disabled item focusable, so the state is the ARIA state.
    expect(
      within(menu).getByRole("menuitem", {
        name: "Refresh, Answer the pending question before changing this conversation",
      })
    ).toHaveAttribute("aria-disabled", "true")
  })

  it("leaves a selected passage to the browser's own menu", async () => {
    render(<LocalThread />)
    const answer = await screen.findByText("The reference is ready.")
    const selection = window.getSelection()
    if (!selection) throw new Error("Expected a document selection")
    const range = document.createRange()
    range.selectNodeContents(answer)
    selection.removeAllRanges()
    selection.addRange(range)

    // An uncancelled event is the browser's own menu still arriving.
    expect(fireEvent.contextMenu(answer, { clientX: 24, clientY: 48 })).toBe(
      true
    )
    expect(screen.queryByRole("menu")).toBeNull()

    selection.removeAllRanges()
    expect(fireEvent.contextMenu(answer, { clientX: 24, clientY: 48 })).toBe(
      false
    )
    expect(await screen.findByRole("menu")).toBeInTheDocument()
  })

  it("hands the press back to the browser after Select text", async () => {
    setTouchPrimary(true)
    const user = userEvent.setup()
    render(<LocalThread />)

    const menu = await openMessageMenu("The reference is ready.")
    await user.click(
      within(menu).getByRole("menuitem", { name: "Select text" })
    )
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())

    expect(
      fireEvent.contextMenu(screen.getByText("The reference is ready."), {
        clientX: 24,
        clientY: 48,
      })
    ).toBe(true)
    expect(screen.queryByRole("menu")).toBeNull()
  })
})
