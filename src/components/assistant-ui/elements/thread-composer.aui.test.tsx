import {
  type AttachmentAdapter,
  type AssistantRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ThreadComponents, type ThreadLabels } from "./thread.aui"
import { RichToolRenderer } from "@/components/tool-ui"
import { PendingInteractionProvider } from "@/components/runtime-interactions/pending-interaction-context"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { steerMessageId } from "@/components/assistant-ui/elements/message-queue"
import {
  setTouchPrimary,
  resetThreadTestEnvironment,
  parkedRun,
  startParkedRun,
  OverlayComposer,
  messageText,
  LocalThread,
  MultiSessionThread,
} from "./thread.aui.test-helpers"

afterEach(resetThreadTestEnvironment)

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

      await waitFor(() => expect(copiedText).toBe("The reference is ready."))
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
    expect(screen.getByText("Review the figures")).toBeVisible()
    expect(screen.getByText("Validated the three segments.")).toBeVisible()
    // Read-only: the nested user turn offers no edit, and the only textbox is
    // the Session's own composer.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull()
    expect(screen.getAllByRole("textbox")).toEqual([
      screen.getByRole("textbox", { name: "Message input" }),
    ])
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
        name: "Respond to the pending request before changing this conversation",
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
        fireEvent.keyDown(screen.getByText("Waiting on native run"), {
          key: "Escape",
          bubbles: true,
        })
      }
      expect(stop).toHaveBeenCalledTimes(1)
      view.unmount()
      expect(stop).toHaveBeenCalledTimes(1)
    }
  )

  it.each<{
    overlay: string
    composerFeatures?: ComposerFeatureViewModel
    composer?: ThreadComponents["Composer"]
    pressEscape: (
      user: ReturnType<typeof userEvent.setup>,
      input: HTMLElement
    ) => Promise<void>
  }>([
    {
      overlay: "conversation search",
      pressEscape: async () => {
        window.dispatchEvent(new Event("aos:conversation-search"))
        const search = await screen.findByRole("searchbox", {
          name: "Search in conversation",
        })
        fireEvent.keyDown(search, { key: "Escape", bubbles: true })
        expect(search).not.toBeInTheDocument()
      },
    },
    {
      overlay: "the model selector",
      composerFeatures: {
        model: {
          options: [
            { id: "opaque-balanced", label: "Balanced" },
            { id: "opaque-fast", label: "Fast" },
          ],
          selectedId: "opaque-balanced",
          update: async () => undefined,
        },
      },
      pressEscape: async (user) => {
        await user.click(screen.getByRole("combobox", { name: "Choose model" }))
        const roster = await screen.findByRole("listbox")
        await user.keyboard("{Escape}")
        await waitFor(() => expect(roster).not.toBeInTheDocument())
      },
    },
    {
      overlay: "the slash command popover",
      composerFeatures: {
        slashCommands: [{ name: "review", description: "Review the diff" }],
      },
      pressEscape: async (user, input) => {
        input.focus()
        await user.keyboard("/rev")
        const commands = await screen.findByRole("listbox", {
          name: "Slash commands",
        })
        await user.keyboard("{Escape}")
        await waitFor(() => expect(commands).not.toBeInTheDocument())
      },
    },
    ...["Inline overlay", "Portaled overlay"].map((name) => ({
      overlay: `an open dialog (${name})`,
      composer: OverlayComposer,
      pressEscape: async () => {
        fireEvent.keyDown(screen.getByRole("dialog", { name }), {
          key: "Escape",
          bubbles: true,
        })
      },
    })),
  ])(
    "does not cancel a running response when Escape closes $overlay",
    async ({ composerFeatures, composer, pressEscape }) => {
      const user = userEvent.setup()
      const stop = vi.fn()
      render(
        <LocalThread
          model={parkedRun(stop)}
          initialMessages={[]}
          composerFeatures={composerFeatures}
          composer={composer}
        />
      )
      const input = await startParkedRun(user)

      await pressEscape(user, input)

      expect(stop).not.toHaveBeenCalled()
    }
  )

  it("cancels a running response when Escape is aimed at the composer", async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    render(<LocalThread model={parkedRun(stop)} initialMessages={[]} />)
    const input = await startParkedRun(user)

    input.focus()
    await user.keyboard("{Escape}")

    expect(stop).toHaveBeenCalledTimes(1)
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

  it.each([
    {
      source: "raw base64 content as a data URL",
      name: "raw-audio.wav",
      mimeType: "audio/wav",
      data: "YXVkaW8=",
      sourceType: undefined,
      label: "Audio attachment: raw-audio.wav",
      player: HTMLAudioElement,
      src: "data:audio/wav;base64,YXVkaW8=",
    },
    {
      source: "a blob URL as it is",
      name: "local-clip.webm",
      mimeType: "video/webm",
      data: "blob:https://aos.test/media-1",
      sourceType: "url" as const,
      label: "Video attachment: local-clip.webm",
      player: HTMLVideoElement,
      src: "blob:https://aos.test/media-1",
    },
  ])(
    "plays a sent media attachment from $source in an inline native player",
    ({ name, mimeType, data, sourceType, label, player, src }) => {
      render(
        <LocalThread
          initialMessages={[
            {
              id: "message-media",
              role: "user",
              content: [],
              attachments: [
                {
                  id: "attachment-media",
                  type: "file",
                  name,
                  contentType: mimeType,
                  status: { type: "complete" },
                  content: [
                    {
                      type: "file",
                      data,
                      filename: name,
                      mimeType,
                      sourceType,
                    },
                  ],
                },
              ],
            },
          ]}
        />
      )

      const element = screen.getByLabelText(label)
      expect(element).toBeInstanceOf(player)
      expect(element).toHaveAttribute("src", src)
      expect(element).toHaveAttribute("controls")
      expect(element).toHaveAttribute("preload", "metadata")
      expect(element).not.toHaveAttribute("autoplay")
    }
  )

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

  it("offers reasoning effort only for a model whose provider reports it, named by its localized level or else the provider", async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => undefined)
    const features = (effortId: string): ComposerFeatureViewModel => ({
      model: {
        options: [
          {
            id: "opaque-balanced",
            label: "Balanced",
            efforts: [
              { id: "low" },
              { id: "high", name: "Deep" },
              { id: "turbo", name: "Turbo" },
            ],
          },
          { id: "opaque-fast", label: "Fast" },
        ],
        selectedId: "opaque-balanced",
        effortId,
        update,
      },
    })
    const view = render(
      <LocalThread initialMessages={[]} composerFeatures={features("turbo")} />
    )

    // One control owns both halves of a model choice.
    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    const effort = await screen.findByRole("slider", { name: "Thinking" })
    // An id outside the ladder reads by its provider's name.
    expect(effort).toHaveAttribute("aria-valuetext", "Turbo")
    effort.focus()
    await user.keyboard("{ArrowDown}")

    expect(update).toHaveBeenCalledWith({ effortId: "high" })

    // A ladder id keeps its localized name over the provider's.
    view.rerender(
      <LocalThread initialMessages={[]} composerFeatures={features("high")} />
    )
    expect(screen.getByRole("slider", { name: "Thinking" })).toHaveAttribute(
      "aria-valuetext",
      "High"
    )

    await user.click(await screen.findByText("Fast"))
    expect(update).toHaveBeenLastCalledWith({ selectedId: "opaque-fast" })
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

  it("preserves a complete attachment when editing only the message text", async () => {
    const user = userEvent.setup()
    let runtime: AssistantRuntime | undefined
    const run = vi.fn<ChatModelAdapter["run"]>().mockResolvedValue({
      content: [{ type: "text", text: "Updated" }],
    })
    render(
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
    const editor = await screen.findByDisplayValue("Review this image")
    await user.clear(editor)
    await user.type(editor, "Review this image carefully")
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

  it.each([
    {
      device: "desktop",
      touch: false,
      newline: "{Shift>}{Enter}{/Shift}",
      submit: "{Enter}",
    },
    {
      device: "touch-primary",
      touch: true,
      newline: "{Enter}",
      submit: "{Control>}{Enter}{/Control}",
    },
  ])(
    "keeps $device message edits multiline until their submit shortcut",
    async ({ touch, newline, submit }) => {
      setTouchPrimary(touch)
      const user = userEvent.setup()
      let runtime: AssistantRuntime | undefined
      const run = vi.fn<ChatModelAdapter["run"]>().mockResolvedValue({
        content: [{ type: "text", text: "Updated" }],
      })
      render(
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
      const editor = await screen.findByDisplayValue("Review this image")
      expect(editor).toHaveAttribute("enterkeyhint", "enter")

      await user.clear(editor)
      await user.type(editor, "First line")
      await user.keyboard(newline)
      await user.type(editor, "Second line")

      expect(editor).toHaveValue("First line\nSecond line")
      expect(run).not.toHaveBeenCalled()

      await user.keyboard(submit)
      await waitFor(() => expect(run).toHaveBeenCalledOnce())
    }
  )

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

  it("uses ArrowDown then Enter or Tab, or a pointer pick, to load history without submitting", async () => {
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

    await user.keyboard("{Control>}r{/Control}")
    await user.click(
      await screen.findByRole("option", { name: "Newer request" })
    )
    expect(input).toHaveValue("Newer request")
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

    // Escape aimed at the transcript, not at the composer.
    fireEvent.keyDown(screen.getByText("first"), {
      key: "Escape",
      keyCode: 0,
      bubbles: true,
    })
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
