import { type ThreadMessageLike } from "@assistant-ui/react"
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createComposerHistorySelector } from "./thread.aui"
import { AosToolPresentation } from "@/components/tool-ui"
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
import {
  setTouchPrimary,
  resetThreadTestEnvironment,
  TURN_TIMING,
  LocalThread,
  openMessageMenu,
} from "./thread.aui.test-helpers"

// The sandboxed frame needs a real browser; a titled stand-in marks where it mounts.
vi.mock("@/components/mcp-apps/mcp-app-frame", () => ({
  default: (props: McpAppFrameProps) => <iframe title={props.title} />,
}))

afterEach(resetThreadTestEnvironment)

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
    // A finished call in a live turn reads by what it did, not as running.
    expect(screen.queryByRole("button", { name: "Running" })).toBeNull()
    expect(screen.getByRole("button", { name: "Read 1 file" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
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

  it("reads a normalized code as localized AOS copy, not the Agent's words, and keeps retry out of the notice", () => {
    render(
      <LocalThread
        initialMessages={failedTurn({ code: "AOS_PROVIDER_RUN_FAILED" })}
      />
    )

    const notice = screen.getByRole("alert", {
      name: `AOS ${en.runErrors.AOS_PROVIDER_RUN_FAILED}`,
    })
    expect(notice).toBeVisible()
    expect(within(notice).queryByRole("button")).not.toBeInTheDocument()
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
})

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
        name: "Refresh, Respond to the pending request before changing this conversation",
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
