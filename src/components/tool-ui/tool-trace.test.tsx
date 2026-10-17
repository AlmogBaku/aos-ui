import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  fromThreadMessageLike,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react"

import { LocalThread } from "@/components/assistant-ui/elements/thread.aui.test-helpers"
import { PendingInteractionProvider } from "@/components/runtime-interactions/pending-interaction-context"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import { withAosToolArtifact, type AosSubagent } from "@/lib/tool-artifact"

import type { ChildSessionControls } from "@/runtime-adapters/child-sessions"

import { ChildSessionControlsProvider } from "./child-session-controls"
import {
  AosToolPresentation,
  ToolUiLocaleProvider,
  isAosRichTool,
} from "./index"
import { toolPart } from "./tool-part.test-helpers"

afterEach(cleanup)

const patch = [
  "--- a/src/pricing/tiers.ts",
  "+++ b/src/pricing/tiers.ts",
  "@@ -1,2 +1,3 @@",
  " export const tiers = []",
  "-export const trialDays = 14",
  "+export const trialDays = 30",
  '+export const enterprise = "contact"',
  "",
].join("\n")

const editPart = toolPart(
  { toolName: "apply_patch", args: { path: "src/pricing/tiers.ts" } },
  {
    kind: "edit",
    locations: [{ path: "src/pricing/tiers.ts" }],
    diffs: [
      { changes: [{ kind: "modify", path: "src/pricing/tiers.ts" }], patch },
    ],
  }
)

const subagent = {
  id: "child-1",
  goal: "Check the pricing tiers",
  model: "opus",
  depth: 1,
  status: "completed",
  tokens: 18_400,
  durationMs: 72_000,
  filesRead: ["a.ts", "b.ts", "c.ts"],
  filesWritten: ["review.md"],
  childSessionId: "session-child",
}

describe("tool kinds", () => {
  it("names a call by its ACP kind before its tool name", () => {
    render(
      <AosToolPresentation
        {...toolPart({ toolName: "lookup" }, { kind: "delete" })}
      />
    )
    expect(
      within(screen.getByRole("button")).getByText("Deleted")
    ).toBeVisible()
  })

  it("lets the tool name decide when the kind says other", () => {
    render(
      <AosToolPresentation
        {...toolPart(
          { toolName: "bash", args: { command: "ls" } },
          { kind: "other" }
        )}
      />
    )
    const trigger = screen.getByRole("button")
    expect(within(trigger).getByText("Ran")).toBeVisible()
    expect(within(trigger).getByText("ls")).toBeVisible()
  })

  it("names the kind in Hebrew", () => {
    render(
      <ToolUiLocaleProvider locale="he">
        <AosToolPresentation
          {...toolPart({ toolName: "http_get" }, { kind: "fetch" })}
        />
      </ToolUiLocaleProvider>
    )
    expect(within(screen.getByRole("button")).getByText("אוחזר")).toBeVisible()
  })
})

describe("tool locations and duration", () => {
  it("cites a file tool's first location left to right with its full path", () => {
    render(
      <AosToolPresentation
        {...toolPart(
          { toolName: "view_source" },
          {
            kind: "read",
            locations: [{ path: "src/pricing/tiers.ts", line: 12 }],
          }
        )}
      />
    )
    const chip = within(screen.getByRole("button")).getByText(
      "src/pricing/tiers.ts:12"
    )
    expect(chip).toHaveAttribute("dir", "ltr")
    expect(chip).toHaveAttribute("title", "src/pricing/tiers.ts:12")
  })

  it("lists every location a search touched in its details", async () => {
    const user = userEvent.setup()
    render(
      <AosToolPresentation
        {...toolPart(
          { toolName: "grep_workspace", args: { pattern: "trialDays" } },
          {
            kind: "search",
            locations: [
              { path: "src/a.ts", line: 2 },
              { path: "src/b.ts", line: 4 },
              { path: "docs/c.md" },
            ],
          }
        )}
      />
    )
    const trigger = screen.getByRole("button")
    expect(within(trigger).getByText("trialDays")).toBeVisible()

    await user.click(trigger)
    const list = screen.getByRole("list", { name: "Locations" })
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["src/a.ts:2", "src/b.ts:4", "docs/c.md"])
  })

  it("counts a file tool's other locations on its row", () => {
    render(
      <AosToolPresentation
        {...toolPart(
          { toolName: "rename_path" },
          {
            kind: "move",
            locations: [{ path: "notes/brief.md" }, { path: "docs/brief.md" }],
          }
        )}
      />
    )
    const trigger = screen.getByRole("button")
    expect(within(trigger).getByText("notes/brief.md")).toBeVisible()
    expect(within(trigger).getByText("+1 more")).toBeVisible()
  })

  it("shows how long a finished call took", () => {
    render(
      <AosToolPresentation
        {...toolPart(
          {
            toolName: "run_command",
            args: { command: "bun test" },
            timing: { startedAt: 1_000, completedAt: 5_200 },
          },
          { kind: "execute" }
        )}
      />
    )
    expect(within(screen.getByRole("button")).getByText("4s")).toBeVisible()
  })
})

describe("tool diffs", () => {
  it("reads the row's line changes aloud and keeps the diff in the details", async () => {
    const user = userEvent.setup()
    render(<AosToolPresentation {...editPart} />)
    const trigger = screen.getByRole("button")
    expect(
      within(trigger).getByText("2 lines added, 1 removed")
    ).toBeInTheDocument()
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    await user.click(trigger)
    await waitFor(() =>
      expect(screen.queryByText("Loading diff…")).not.toBeInTheDocument()
    )
    expect(
      screen.getAllByText(/src\/pricing\/tiers\.ts/).length
    ).toBeGreaterThan(1)
  })

  it("reads the line changes in Hebrew", () => {
    render(
      <ToolUiLocaleProvider locale="he">
        <AosToolPresentation {...editPart} />
      </ToolUiLocaleProvider>
    )
    expect(
      within(screen.getByRole("button")).getByText(
        "2 שורות נוספו, שורה אחת הוסרה"
      )
    ).toBeInTheDocument()
  })
})

describe("tool terminals", () => {
  const liveTerminal = (output: string) =>
    toolPart(
      {
        toolName: "run_command",
        args: { command: "bun test" },
        status: { type: "running" },
      },
      {
        kind: "execute",
        terminals: [
          { terminalId: "t-1", command: "bun test", output, running: true },
        ],
      }
    )

  it("opens a running terminal and stays closed once the user closes it", async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <AosToolPresentation {...liveTerminal("one")} />
    )
    const trigger = screen.getByRole("button", { expanded: true })

    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    rerender(<AosToolPresentation {...liveTerminal("one\ntwo")} />)
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false")
  })

  it("keeps a failed terminal's output and exit code instead of a bare error", async () => {
    const user = userEvent.setup()
    render(
      <AosToolPresentation
        {...toolPart(
          {
            toolName: "run_command",
            args: { command: "bun run lint" },
            status: { type: "incomplete", reason: "error" },
            isError: true,
          },
          {
            kind: "execute",
            terminals: [
              {
                terminalId: "t-2",
                command: "bun run lint",
                output: "1 problem",
                running: false,
                exitCode: 1,
              },
            ],
          }
        )}
      />
    )
    await user.click(screen.getByRole("button"))
    expect(await screen.findByText("Exit code 1")).toBeInTheDocument()
  })
})

describe("subagents", () => {
  const subagentPart = toolPart(
    { toolName: "spawn_agent", args: { task: "Check tiers" } },
    { kind: "other", subagent }
  )

  const delegation = { toolName: "delegate_subagent", args: { task: "Price" } }
  const settled = { ...delegation, result: { status: "completed" } }
  it.each([
    ["while it runs", false, toolPart(delegation)],
    ["once it spawned children", false, toolPart(settled, { delegated: 2 })],
    ["when it settled with none", true, toolPart(settled)],
    [
      "while it asks a permission",
      true,
      toolPart({
        ...delegation,
        approval: { id: "ask", prompt: "Delegate the pricing research?" },
      }),
    ],
  ])("reads the delegating call %s as rich: %s", (_case, rich, part) => {
    expect(isAosRichTool(part)).toBe(rich)
  })

  it("shows a subagent as one row, whatever its tool is called", async () => {
    expect(isAosRichTool(subagentPart)).toBe(true)
    render(<AosToolPresentation {...subagentPart} />)

    const goal = await screen.findByText("Check the pricing tiers")
    expect(goal).toHaveAttribute("title", "Check the pricing tiers")
    expect(screen.getByRole("status")).toHaveTextContent("Completed")
    expect(screen.getByText("1m 12s")).toBeVisible()
    expect(screen.queryByText("Model opus")).toBeNull()
  })

  // The summary used to be dropped on the way to the row.
  it("shows the summary its child Session reports", async () => {
    render(
      <AosToolPresentation
        {...toolPart(
          { toolName: "spawn_agent" },
          { subagent: { ...subagent, summary: "The tiers match the page." } }
        )}
      />
    )
    expect(await screen.findByText("The tiers match the page.")).toBeVisible()
  })

  it("keeps a failed subagent's status and reason rather than a bare error", async () => {
    render(
      <AosToolPresentation
        {...toolPart(
          {
            toolName: "spawn_agent",
            status: { type: "incomplete", reason: "error" },
          },
          {
            subagent: {
              ...subagent,
              status: "failed",
              summary: "interviews-q3.docx could not be opened.",
            },
          }
        )}
      />
    )
    expect(await screen.findByRole("status")).toHaveTextContent("Failed")
    expect(screen.getByText("Check the pricing tiers")).toBeVisible()
    expect(
      screen.getByText("interviews-q3.docx could not be opened.")
    ).toBeVisible()
  })

  it("reads the row in Hebrew", async () => {
    render(
      <ToolUiLocaleProvider locale="he">
        <AosToolPresentation {...subagentPart} />
      </ToolUiLocaleProvider>
    )
    expect(await screen.findByRole("status")).toHaveTextContent("הושלם")
    expect(screen.getByText("1 דק׳ 12 שנ׳")).toBeVisible()
  })

  describe("in a batch", () => {
    const GOALS = [
      "Research Northwind's 2026 pricing",
      "Reconcile September's supplier invoices",
      "Draft follow-ups to the trade-show leads",
    ]
    const batch = (statuses: readonly string[]): ThreadMessageLike[] => [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "Prepare the board meeting" }],
      },
      {
        id: "a1",
        role: "assistant",
        content: statuses.map((status, index) => ({
          type: "tool-call",
          toolCallId: `aos-subagent-child-${index}`,
          toolName: "subagent",
          args: {},
          argsText: "{}",
          artifact: withAosToolArtifact(undefined, {
            subagent: {
              id: `child-${index}`,
              childSessionId: `child-${index}`,
              goal: GOALS[index],
              status,
            },
          }),
        })),
      },
    ]

    it.each([
      [
        "stays open while a child runs",
        ["running", "completed", "failed"],
        false,
        true,
        ["1 running", "1 done", "1 failed"],
      ],
      [
        "collapses once every child is done",
        ["completed", "completed", "unknown"],
        false,
        false,
        ["2 done", "1 status unavailable"],
      ],
      [
        "keeps the reader's own close over a running child",
        ["running", "waiting"],
        true,
        false,
        ["1 running", "1 waiting"],
      ],
      [
        "keeps the reader's own open once every child is done",
        ["completed", "failed"],
        true,
        true,
        ["1 done", "1 failed"],
      ],
    ] as const)(
      "counts each child by its own state and %s",
      async (_case, statuses, toggles, open, counts) => {
        const user = userEvent.setup()
        render(
          <LocalThread
            toolFallback={AosToolPresentation}
            initialMessages={batch(statuses)}
          />
        )
        const header = await screen.findByRole("button", {
          name: new RegExp(`^${statuses.length} subagents`),
        })
        if (toggles) await user.click(header)

        expect(header).toHaveAttribute("aria-expanded", String(open))
        for (const count of counts)
          expect(within(header).getByText(count)).toBeInTheDocument()
        expect(screen.queryByText(GOALS[0]!) !== null).toBe(open)
      }
    )
  })

  describe("over its child Session", () => {
    const CHILD_ID = "session-child"
    const running: AosSubagent = {
      ...subagent,
      status: "running",
      cancellable: true,
    }
    const childTurn = (
      content: ThreadMessageLike["content"],
      id = "child-answer"
    ): ThreadMessage =>
      fromThreadMessageLike({ id, role: "assistant", content }, id, {
        type: "running",
      })
    /** A thread whose one turn spawned the child, with its transcript nested. */
    const threadWith = (
      card: AosSubagent,
      transcript: readonly ThreadMessage[]
    ): ThreadMessageLike[] => [
      { id: "u1", role: "user", content: [{ type: "text", text: "Check" }] },
      {
        id: "a1",
        role: "assistant",
        status: { type: "running" },
        content: [
          {
            type: "tool-call",
            toolCallId: "spawn",
            toolName: "delegate_task",
            args: { task: "Check tiers" },
            argsText: "{}",
            artifact: withAosToolArtifact(undefined, { subagent: card }),
            messages: transcript,
          },
        ],
      },
    ]
    const controls = () => ({
      respondToApproval: vi.fn<ChildSessionControls["respondToApproval"]>(
        async () => {}
      ),
      cancel: vi.fn(),
      runningCount: () => 0,
      cancelRunning: () => 0,
    })

    /** A call in the child's transcript that asks a permission. */
    const asking = (toolCallId: string, prompt: string) =>
      ({
        type: "tool-call",
        toolCallId,
        toolName: "bash",
        args: { command: "rm -rf build" },
        argsText: "{}",
        approval: {
          id: "child-permission",
          prompt,
          options: [
            { id: "once", kind: "allow-once" },
            { id: "deny", kind: "reject-once" },
          ],
        },
      }) as const

    // The child's own child asks under the same request id, and each answer
    // goes to the Session its request came from.
    // A child the gateway no longer follows may still be at work, or done:
    // the card says neither, and offers no Stop it could not confirm.
    it("says a child no longer followed is unconfirmed, and offers no Stop", async () => {
      render(
        <ChildSessionControlsProvider controls={controls()}>
          <LocalThread
            toolFallback={AosToolPresentation}
            initialMessages={threadWith({ ...running, status: "unknown" }, [])}
          />
        </ChildSessionControlsProvider>
      )

      expect(await screen.findByText("Status unavailable")).toBeVisible()
      expect(screen.queryByText("Running")).toBeNull()
      expect(screen.queryByRole("button", { name: "Stop subagent" })).toBeNull()
    })

    it("answers each permission request on the child Session that asked it", async () => {
      const user = userEvent.setup()
      const child = controls()
      render(
        <ChildSessionControlsProvider controls={child}>
          <LocalThread
            toolFallback={AosToolPresentation}
            initialMessages={threadWith(running, [
              childTurn([
                asking("child-bash", "Delete the build directory?"),
                {
                  type: "tool-call",
                  toolCallId: "grandchild-spawn",
                  toolName: "delegate_task",
                  args: {},
                  argsText: "{}",
                  artifact: withAosToolArtifact(undefined, {
                    subagent: {
                      id: "grandchild",
                      childSessionId: "session-grandchild",
                      status: "running",
                    },
                  }),
                  messages: [
                    childTurn(
                      [asking("grandchild-bash", "Delete the cache?")],
                      "grandchild-answer"
                    ),
                  ],
                },
              ]),
            ])}
          />
        </ChildSessionControlsProvider>
      )

      const choices = await screen.findByRole("group", {
        name: "Delete the build directory?",
      })
      await user.click(within(choices).getByRole("button", { name: "Reject" }))
      const nestedChoices = await screen.findByRole("group", {
        name: "Delete the cache?",
      })
      await user.click(
        within(nestedChoices).getByRole("button", { name: "Allow once" })
      )
      expect(child.respondToApproval.mock.calls).toEqual([
        [CHILD_ID, "child-permission", "deny", false],
        ["session-grandchild", "child-permission", "once", true],
      ])
    })

    it("answers a permission request the child asked before writing anything", async () => {
      const user = userEvent.setup()
      const child = controls()
      render(
        <ChildSessionControlsProvider controls={child}>
          <LocalThread
            toolFallback={AosToolPresentation}
            initialMessages={threadWith(
              {
                ...running,
                approvals: [
                  {
                    id: "early-permission",
                    action: "Run bash",
                    prompt: "Delete the build directory?",
                    options: [
                      { id: "once", kind: "allow-once" },
                      { id: "deny", kind: "reject-once" },
                    ],
                  },
                ],
              },
              []
            )}
          />
        </ChildSessionControlsProvider>
      )

      const choices = await screen.findByRole("group", {
        name: "Delete the build directory?",
      })
      await user.click(
        within(choices).getByRole("button", { name: "Allow once" })
      )
      expect(child.respondToApproval).toHaveBeenCalledExactlyOnceWith(
        CHILD_ID,
        "early-permission",
        "once",
        true
      )
    })

    it("answers the child's question on the card", async () => {
      const user = userEvent.setup()
      const request: RuntimeQuestionRequest = {
        kind: "question",
        requestId: "child-question",
        sessionId: CHILD_ID,
        questions: [
          {
            header: "Scope",
            prompt: "Check the enterprise tier too?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      }
      const interactions: RuntimeInteractionAdapter = {
        respond: vi.fn(async () => {}),
        reject: vi.fn(async () => {}),
        getPending: (sessionId) =>
          sessionId === CHILD_ID ? request : undefined,
        subscribe: () => () => {},
      }
      render(
        <PendingInteractionProvider interactions={interactions}>
          <LocalThread
            toolFallback={AosToolPresentation}
            initialMessages={threadWith(running, [])}
          />
        </PendingInteractionProvider>
      )

      expect(
        await screen.findByText("Check the enterprise tier too?")
      ).toBeVisible()
      await user.click(screen.getByRole("option", { name: "Yes" }))
      await user.click(screen.getByRole("button", { name: "Send answer" }))
      expect(interactions.respond).toHaveBeenCalledWith(request, {
        kind: "question",
        answers: [["Yes"]],
      })
    })
  })
})
