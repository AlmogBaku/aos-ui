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
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createComposerHistorySelector,
  Thread,
  THREAD_VIEWPORT_SCROLL_BEHAVIOR,
  type ThreadComponents,
  type ThreadLabels,
} from "./thread.aui"
import { AosToolPresentation, RichToolRenderer } from "@/components/tool-ui"

afterEach(cleanup)

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

  it("keeps intermediate assistant prose inside the timeline and the final answer visible", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        toolFallback={AosToolPresentation}
        initialMessages={[
          {
            id: "tool-loop-with-final",
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I will inspect the project first.",
              },
              {
                type: "tool-call",
                toolCallId: "read-project",
                toolName: "read_file",
                args: { path: "README.md" },
                result: "contents",
              },
              {
                type: "text",
                text: "The final answer remains in the conversation.",
              },
            ],
          },
        ]}
      />
    )

    expect(
      screen.getByText("The final answer remains in the conversation.")
    ).toBeVisible()
    expect(screen.queryByText("I will inspect the project first.")).toBeNull()

    await user.click(screen.getByRole("button", { name: "1 tool call" }))
    expect(screen.getByText("I will inspect the project first.")).toBeVisible()
  })
})

describe("thread scroll ownership", () => {
  it("leaves automatic scrolling to the reading-position controller", () => {
    expect(THREAD_VIEWPORT_SCROLL_BEHAVIOR).toEqual({
      autoScroll: false,
      scrollToBottomOnInitialize: false,
      scrollToBottomOnThreadSwitch: false,
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
}: {
  labels?: Partial<ThreadLabels>
  direction?: "ltr" | "rtl"
  model?: ChatModelAdapter
  exposeRuntime?: (runtime: AssistantRuntime) => void
  initialMessages?: readonly ThreadMessageLike[]
  toolFallback?: typeof RichToolRenderer
  composer?: ThreadComponents["Composer"]
  composerFeatures?: {
    slashCommands?: readonly { name: string; description?: string }[]
    model?: {
      options: readonly { id: string; label: string; group?: string }[]
      selectedId: string
      select(id: string): Promise<void>
    }
    context?: {
      usage: { system: number; tools: number; messages: number; total: number }
      segments?: readonly ("system" | "tools" | "messages")[]
    }
  }
  enableMessageQueue?: boolean
  attachmentAdapter?: AttachmentAdapter
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
      <Thread
        labels={labels}
        direction={direction}
        autoFocus={false}
        composerFeatures={composerFeatures}
        components={{ ToolFallback: toolFallback, Composer: composer }}
      />
    </AssistantRuntimeProvider>
  )
}

describe("slash command completion", () => {
  it("scrolls the highlighted command within a clipped menu without moving focus", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        composerFeatures={{
          slashCommands: Array.from({ length: 30 }, (_, index) => ({
            name: `command-${index}`,
          })),
        }}
      />
    )
    const input = screen.getByRole("textbox", { name: "Message input" })
    await user.type(input, "/")
    const menu = await screen.findByRole("listbox")
    Object.defineProperty(menu, "clientHeight", {
      configurable: true,
      value: 100,
    })
    vi.spyOn(menu, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 200, 100)
    )
    const options = screen.getAllByRole("option")
    options.forEach((option, index) => {
      vi.spyOn(option, "getBoundingClientRect").mockImplementation(
        () => new DOMRect(0, index * 40 - menu.scrollTop, 200, 40)
      )
    })
    for (let i = 0; i < 15; i++) await user.keyboard("{ArrowDown}")
    expect(menu.scrollTop).toBe(540)
    for (let i = 0; i < 15; i++) await user.keyboard("{ArrowUp}")
    expect(menu.scrollTop).toBe(0)
    expect(input).toHaveFocus()
    expect(input).toHaveValue("/")
  })

  const slashCommands = [
    { name: "help", description: "Available commands" },
    { name: "summarize", description: "Summarize conversation" },
  ]

  it("filters and inserts editable text without sending on keyboard selection", async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => ({ content: [] }))
    render(<LocalThread model={{ run }} composerFeatures={{ slashCommands }} />)
    const input = screen.getByRole("textbox", { name: "Message input" })
    await user.type(input, "/su")
    expect(
      await screen.findByRole("option", { name: /summarize/ })
    ).toHaveTextContent("Summarize conversation")
    expect(
      screen.queryByRole("option", { name: /help/ })
    ).not.toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(input).toHaveValue("/summarize ")
    expect(input).toHaveFocus()
    expect(run).not.toHaveBeenCalled()
    await user.type(input, "today")
    expect(input).toHaveValue("/summarize today")
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("navigates suggestions instead of history and closes with Escape", async () => {
    const user = userEvent.setup()
    render(<LocalThread composerFeatures={{ slashCommands }} />)
    const input = screen.getByRole("textbox", { name: "Message input" })
    await user.type(input, "/")
    await screen.findByRole("option", { name: /help/ })
    await user.keyboard("{ArrowDown}{Tab}")
    expect(input).toHaveValue("/summarize ")
    await user.clear(input)
    await user.type(input, "/")
    await screen.findByRole("listbox")
    await user.keyboard("{Escape}")
    expect(input).toHaveValue("/")
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("supports pointer selection and localized accessible names", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        direction="rtl"
        labels={{ slashCommands: "פקודות" }}
        composerFeatures={{ slashCommands }}
      />
    )
    const input = screen.getByRole("textbox", { name: "Message input" })
    await user.type(input, "/")
    expect(await screen.findByRole("listbox", { name: "פקודות" })).toBeVisible()
    await user.click(screen.getByRole("option", { name: /help/ }))
    expect(input).toHaveValue("/help ")
    expect(input).toHaveFocus()
  })

  it.each([undefined, []])(
    "shows no suggestions for a hidden or unavailable catalog: %s",
    async (commands) => {
      const user = userEvent.setup()
      render(
        <LocalThread
          composerFeatures={commands ? { slashCommands: commands } : {}}
        />
      )
      await user.type(
        screen.getByRole("textbox", { name: "Message input" }),
        "/"
      )
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    }
  )

  it.each(["hello /", " /", "/unknown", "/help argument"])(
    "does not complete outside a matching leading command: %s",
    async (text) => {
      const user = userEvent.setup()
      render(<LocalThread composerFeatures={{ slashCommands }} />)
      await user.type(
        screen.getByRole("textbox", { name: "Message input" }),
        text
      )
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    }
  )
})

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

  it("renders an optional model selector and exact authoritative context usage", async () => {
    const user = userEvent.setup()
    const select = vi.fn(async () => undefined)
    render(
      <LocalThread
        initialMessages={[]}
        composerFeatures={{
          model: {
            options: [
              { id: "opaque-balanced", label: "Balanced", group: "Fixture" },
              { id: "opaque-fast", label: "Fast", group: "Fixture" },
            ],
            selectedId: "opaque-balanced",
            select,
          },
          context: {
            usage: { system: 1, tools: 1, messages: 2, total: 8 },
          },
        }}
      />
    )

    const model = screen.getByRole("combobox", { name: "Choose model" })
    expect(model).toHaveTextContent("Balanced")
    const context = screen.getByRole("button", { name: "Context usage" })
    expect(context).toBeInTheDocument()
    expect(screen.getByText("Context")).toBeInTheDocument()
    expect(screen.getByText("System")).toBeInTheDocument()
    expect(screen.getByText("Tools")).toBeInTheDocument()
    expect(screen.getByText("Messages")).toBeInTheDocument()
    expect(screen.getByText("4k / 8k")).toBeInTheDocument()
    expect(model).toBeInTheDocument()
    expect(context).toBeInTheDocument()

    model.focus()
    await user.keyboard("{ArrowDown}")
    expect(await screen.findByRole("listbox")).toBeVisible()
    expect(screen.getByRole("group", { name: "Fixture" })).toBeInTheDocument()
    await user.keyboard("{ArrowDown}{Enter}")
    expect(select).toHaveBeenCalledWith("opaque-fast")
  })

  it("allows model and context composer features to be omitted independently", () => {
    render(
      <LocalThread
        initialMessages={[]}
        composerFeatures={{
          context: { usage: { system: 0, tools: 0, messages: 0, total: 4 } },
        }}
      />
    )

    expect(screen.queryByRole("combobox", { name: "Choose model" })).toBeNull()
    expect(
      screen.getByRole("button", { name: "Context usage" })
    ).toBeInTheDocument()
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
            select: async () => undefined,
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
            select: async () => undefined,
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

  it("queues busy Enter exactly once in the queue lane", async () => {
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
    await user.keyboard("{Enter}")
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    await user.type(input, "second")
    await user.keyboard("{Enter}")
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Queued messages" })
      ).toBeVisible()
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(screen.getByText("second")).toBeInTheDocument()

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
    await user.keyboard("{Enter}")
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(screen.getByText("second")).toBeInTheDocument()
    await act(async () => release?.())
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
    await user.keyboard("{Enter}")
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await user.type(input, "park me")
    await user.keyboard("{Enter}")
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
    await user.keyboard("{Enter}")
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await user.type(input, "queued")
    await user.keyboard("{Enter}")
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
