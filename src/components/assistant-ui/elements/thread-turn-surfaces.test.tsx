import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import type {
  ComposerFeatureViewModel,
  ComposerModelCurrent,
} from "@/components/assistant-ui/composer-features"
import { threadLabels } from "@/components/assistant-ui/thread-labels"
import {
  AosToolPresentation,
  ToolUiLocaleProvider,
  type ToolUiLocale,
} from "@/components/tool-ui"
import { he } from "@/lib/i18n/dictionaries/he"
import { Thread, type ThreadLabels } from "./thread.aui"

afterEach(cleanup)

const TIMING = {
  streamStartTime: Date.parse("2026-09-03T09:11:31.000Z"),
  totalStreamTime: 40_000,
  totalChunks: 12,
  toolCallCount: 2,
}

function LocalThread({
  messages = [],
  locale,
  labels,
  composerFeatures,
}: {
  messages?: readonly ThreadMessageLike[]
  locale?: ToolUiLocale
  labels?: Partial<ThreadLabels>
  composerFeatures?: ComposerFeatureViewModel
}) {
  const runtime = useLocalRuntime(
    { run: async () => ({ content: [] }) },
    { initialMessages: messages }
  )
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUiLocaleProvider locale={locale}>
        <Thread
          autoFocus={false}
          labels={labels}
          direction={locale === "he" ? "rtl" : "ltr"}
          composerFeatures={composerFeatures}
          components={{ ToolFallback: AosToolPresentation }}
        />
      </ToolUiLocaleProvider>
    </AssistantRuntimeProvider>
  )
}

const read = {
  type: "tool-call",
  toolCallId: "read",
  toolName: "read_file",
  args: { path: "README.md" },
  result: "contents",
} as const

function turn(
  content: ThreadMessageLike["content"],
  status?: ThreadMessageLike["status"]
): ThreadMessageLike[] {
  return [
    { id: "u1", role: "user", content: [{ type: "text", text: "Go" }] },
    {
      id: "a1",
      role: "assistant",
      metadata: { timing: TIMING },
      content,
      ...(status ? { status } : {}),
    },
  ]
}

describe("model stop notices", () => {
  it("keeps a length-limited answer and says under it why it ends", async () => {
    render(
      <LocalThread
        messages={turn([read, { type: "text", text: "First, second, third" }], {
          type: "incomplete",
          reason: "length",
        })}
      />
    )

    expect(screen.getByText("First, second, third")).toBeVisible()
    expect(
      screen.getByRole("status", {
        name: "AOS The answer stopped at the length limit.",
      })
    ).toBeVisible()
    expect(
      await screen.findByRole("button", {
        name: "Stopped at the length limit after 40s",
      })
    ).toBeVisible()
  })

  it("names a refusal in Hebrew as AOS, not as the Agent", async () => {
    render(
      <LocalThread
        locale="he"
        messages={turn([read, { type: "text", text: "לא אוכל לעזור." }], {
          type: "incomplete",
          reason: "content-filter",
        })}
      />
    )

    const notice = screen.getByRole("status", {
      name: `AOS ${he.turnStopped.contentFilter}`,
    })
    expect(notice).toHaveAttribute("dir", "rtl")
    expect(
      await screen.findByRole("button", { name: "סירב אחרי 40 שנ׳" })
    ).toBeVisible()
  })

  it("adds no stop notice to a turn that completed", () => {
    render(<LocalThread messages={turn([{ type: "text", text: "Done." }])} />)

    expect(screen.queryByRole("status", { name: /^AOS / })).toBeNull()
  })
})

describe("turn failure detail", () => {
  it("names the provider and model that failed", () => {
    render(
      <LocalThread
        messages={turn([{ type: "text", text: "Half an answer" }], {
          type: "incomplete",
          reason: "error",
          error: {
            code: "AOS_PROVIDER_RUN_FAILED",
            message: "The upstream model returned 529.",
            provider: "Fixture Cloud",
            model: "fixture-balanced",
          },
        })}
      />
    )

    expect(
      within(screen.getByRole("alert")).getByText(
        "Fixture Cloud · fixture-balanced"
      )
    ).toBeVisible()
  })

  it("shows no attribution line when the failure names neither", () => {
    render(
      <LocalThread
        messages={turn([{ type: "text", text: "Half an answer" }], {
          type: "incomplete",
          reason: "error",
          error: { code: "AOS_PROVIDER_RUN_FAILED" },
        })}
      />
    )

    expect(within(screen.getByRole("alert")).queryByText(/·/u)).toBeNull()
  })
})

describe("settled fold headline", () => {
  const patch = (additions: number, deletions: number) =>
    [
      "--- a/file",
      "+++ b/file",
      ...Array.from({ length: additions }, (_, index) => `+added ${index}`),
      ...Array.from({ length: deletions }, (_, index) => `-removed ${index}`),
    ].join("\n")

  it("names only the turn's duration, not what its tools changed", async () => {
    render(
      <LocalThread
        messages={turn([
          {
            ...read,
            toolCallId: "edit-1",
            toolName: "edit_file",
            artifact: {
              aos: {
                kind: "edit",
                diffs: [
                  {
                    changes: [
                      { kind: "modify", path: "a.ts" },
                      { kind: "add", path: "b.ts" },
                    ],
                    patch: patch(40, 7),
                  },
                ],
              },
            },
          },
          {
            ...read,
            toolCallId: "edit-2",
            toolName: "edit_file",
            artifact: {
              aos: {
                kind: "edit",
                diffs: [
                  {
                    changes: [{ kind: "modify", path: "c.ts" }],
                    patch: patch(2, 0),
                  },
                ],
              },
            },
          },
          { type: "text", text: "Both edits are in." },
        ])}
      />
    )

    expect(
      await screen.findByRole("button", {
        name: "Worked for 40s",
      })
    ).toBeVisible()
  })
})

describe("context compaction", () => {
  const compaction = (data: Record<string, unknown>) =>
    ({ type: "data", name: "aos-compaction", data }) as const

  it("splits the fold around a mid-turn compaction and keeps its summary one disclosure away", async () => {
    const user = userEvent.setup()
    render(
      <LocalThread
        messages={turn([
          read,
          compaction({
            compactionId: "c1",
            status: "completed",
            summary: "Earlier turns reviewed README.md.",
          }),
          {
            ...read,
            toolCallId: "command",
            toolName: "run_command",
            args: { command: "bun run test" },
          },
          { type: "text", text: "All tests pass." },
        ])}
      />
    )

    const before = await screen.findByRole("button", {
      name: "Worked for 40s",
    })
    const divider = await screen.findByRole("button", {
      name: "Context compacted",
    })
    const after = screen.getByRole("button", { name: "Ran 1 command" })
    expect(before.compareDocumentPosition(divider)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(divider.compareDocumentPosition(after)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(divider).toHaveAttribute("aria-expanded", "false")

    await user.click(divider)
    expect(divider).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Earlier turns reviewed README.md.")).toBeVisible()
  })

  it("says a compaction is under way while it runs", async () => {
    render(
      <LocalThread
        messages={turn([
          compaction({ compactionId: "c2", status: "started" }),
          { type: "text", text: "Continuing." },
        ])}
      />
    )

    expect(await screen.findByText("Compacting context…")).toBeVisible()
  })

  it("reports a failed compaction as a warning from AOS", async () => {
    render(
      <LocalThread
        messages={turn([
          compaction({
            compactionId: "c3",
            status: "failed",
            error: "The summarizer timed out.",
          }),
          { type: "text", text: "Continuing." },
        ])}
      />
    )

    const notice = await screen.findByRole("status", {
      name: "AOS Context compaction failed.",
    })
    expect(within(notice).getByText("The summarizer timed out.")).toBeVisible()
  })
})

const MODEL_OPTIONS = [
  { id: "model-a", label: "Model A" },
  { id: "model-b", label: "Model B" },
]

function modelFeed(initial: ComposerModelCurrent) {
  let reading = initial
  const listeners = new Set<() => void>()
  return {
    feed: {
      current: () => reading,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    report(next: ComposerModelCurrent) {
      reading = next
      for (const listener of listeners) listener()
    },
  }
}

describe("composer model follow", () => {
  it("follows a model change the provider reports", async () => {
    const provider = modelFeed({ selectedId: "model-a" })
    render(
      <LocalThread
        composerFeatures={{
          model: {
            options: MODEL_OPTIONS,
            selectedId: "model-a",
            selection: { status: "idle" },
            update: async () => undefined,
            follow: provider.feed,
          },
        }}
      />
    )

    const trigger = await screen.findByRole("combobox", {
      name: "Choose model",
    })
    expect(trigger).toHaveTextContent("Model A")

    act(() => provider.report({ selectedId: "model-b" }))
    expect(trigger).toHaveTextContent("Model B")
  })

  it("keeps the operator's pending pick over an older provider reading", async () => {
    const provider = modelFeed({ selectedId: "model-a" })
    render(
      <LocalThread
        composerFeatures={{
          model: {
            options: MODEL_OPTIONS,
            selectedId: "model-b",
            selection: {
              status: "pending",
              target: { selectedId: "model-b" },
            },
            update: async () => undefined,
            follow: provider.feed,
          },
        }}
      />
    )

    expect(
      await screen.findByRole("combobox", { name: "Choose model" })
    ).toHaveTextContent("Model B")
  })
})

describe("composer usage and cost", () => {
  const context = {
    usage: { system: 2, tools: 1, messages: 9, total: 66 },
    lastTurn: {
      inputTokens: 12_480,
      outputTokens: 1_236,
      cachedReadTokens: 8_192,
    },
    cost: { amount: 0.42, currency: "USD" },
  }

  it("shows the last turn's tokens and the Session's cost", () => {
    render(<LocalThread composerFeatures={{ context }} />)

    expect(screen.getByText("Last turn")).toBeInTheDocument()
    expect(
      screen.getByText("12K in · 1.2K out · 8.2K cached")
    ).toBeInTheDocument()
    expect(screen.getByText("Session cost")).toBeInTheDocument()
    expect(screen.getByText("$0.42")).toBeInTheDocument()
  })

  it("formats both rows for the Hebrew locale", () => {
    render(
      <LocalThread
        locale="he"
        labels={threadLabels.he}
        composerFeatures={{ context }}
      />
    )

    expect(screen.getByText("התור האחרון")).toBeInTheDocument()
    expect(screen.getByText(/קלט · .* פלט · .* במטמון/u)).toBeInTheDocument()
    expect(screen.getByText("עלות השיחה")).toBeInTheDocument()
    expect(screen.getByText(/0\.42/u)).toBeInTheDocument()
  })

  it("leaves both rows out when the provider reports neither", () => {
    render(
      <LocalThread composerFeatures={{ context: { usage: context.usage } }} />
    )

    expect(screen.queryByText("Last turn")).toBeNull()
    expect(screen.queryByText("Session cost")).toBeNull()
  })
})
