import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  type AssistantRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
  useAuiState,
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
import { createPortal } from "react-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
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
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { PendingInteractionProvider } from "@/components/runtime-interactions/pending-interaction-context"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { steerMessageId } from "@/components/assistant-ui/elements/message-queue"

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

describe("assistant tool timeline", () => {
  it("renders one timeline while keeping completed tool UI visible", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        toolFallback={AosToolPresentation}
        initialMessages={[
          {
            id: "tools-complete",
            role: "assistant",
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
                result: {
                  type: "line",
                  xKey: "quarter",
                  series: [{ key: "applied", label: "Applied AI" }],
                  data: [
                    { quarter: "Q4 ’24", applied: 103 },
                    { quarter: "Q1 ’25", applied: 128 },
                  ],
                },
              },
            ],
          },
        ]}
      />
    )

    expect(
      document.querySelectorAll('[data-slot="tool-timeline"]')
    ).toHaveLength(1)
    const trigger = await screen.findByRole("button", {
      name: "Reasoning · 3 tool calls",
    })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    const reasoning = screen.getByRole("button", {
      name: /^Reasoning$/,
    })
    await user.click(reasoning)
    expect(
      screen.getByText("I should inspect the project before changing it.")
    ).toBeVisible()
    expect(document.querySelectorAll('[data-slot="tool-call"]')).toHaveLength(3)
    expect(screen.getAllByText("Read")).toHaveLength(1)
    expect(screen.getAllByText("Searched")).toHaveLength(1)
    expect(screen.getAllByText("Loaded")).toHaveLength(1)
    expect(screen.getByText("kb")).toBeVisible()
    expect(
      screen.queryByText("private skill instructions must stay hidden")
    ).toBeNull()
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-slot="tool-chrome"]')
      ).toHaveLength(1)
    )
  })

  it("keeps assistant prose visible between completed tool calls", async () => {
    render(
      <LocalThread
        toolFallback={AosToolPresentation}
        initialMessages={[
          {
            id: "tool-loop-with-interleaved-prose",
            role: "assistant",
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
            ],
          },
        ]}
      />
    )

    const prose = screen.getByText(
      "Big finding already. Let me fix the call-site shape."
    )
    const timelines = document.querySelectorAll(
      '[data-slot="message-tool-experience"]'
    )

    expect(prose).toBeVisible()
    expect(timelines).toHaveLength(2)
    expect(timelines[0]?.compareDocumentPosition(prose)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(prose.compareDocumentPosition(timelines[1]!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
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
                efforts: ["low", "high"],
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
