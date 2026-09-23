import {
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
  AosToolPresentation,
  ToolUiLocaleProvider,
  ToolUiSessionLinkProvider,
  isAosRichTool,
  withAosToolArtifact,
  type AosToolArtifact,
  type RichToolPart,
} from "./index"

afterEach(cleanup)

function toolPart(
  overrides: Partial<RichToolPart> & Pick<RichToolPart, "toolName">,
  artifact?: AosToolArtifact
): RichToolPart {
  const args = overrides.args ?? {}
  return {
    type: "tool-call",
    toolCallId: `test-${overrides.toolName}`,
    args,
    argsText: JSON.stringify(args),
    status: { type: "complete" },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn().mockResolvedValue(undefined),
    ...(artifact ? { artifact: withAosToolArtifact(undefined, artifact) } : {}),
    ...overrides,
  }
}

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
    expect(within(screen.getByRole("button")).getByText("4 s")).toBeVisible()
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

  it("shows a subagent as activity, whatever its tool is called", async () => {
    expect(isAosRichTool(subagentPart)).toBe(true)
    render(<AosToolPresentation {...subagentPart} />)

    expect(await screen.findByText("Check the pricing tiers")).toBeVisible()
    for (const fact of [
      "Model opus",
      "Depth 1",
      "Completed",
      "18K tokens",
      "Took 1 min 12 s",
      "Read 3 files",
      "Wrote 1 file",
    ])
      expect(screen.getByText(fact)).toBeInTheDocument()
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("links to the child Session where the surface can open one", async () => {
    const open = vi.fn()
    render(
      <ToolUiSessionLinkProvider
        sessionLink={(id) => ({ href: `/agents/a/${id}`, open })}
      >
        <AosToolPresentation {...subagentPart} />
      </ToolUiSessionLinkProvider>
    )
    const link = await screen.findByRole("link", { name: "Open session" })
    expect(link).toHaveAttribute("href", "/agents/a/session-child")
    fireEvent.click(link)
    expect(open).toHaveBeenCalledTimes(1)
    fireEvent.click(link, { ctrlKey: true })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("keeps a failed subagent's status rather than a bare error", async () => {
    render(
      <AosToolPresentation
        {...toolPart(
          {
            toolName: "spawn_agent",
            status: { type: "incomplete", reason: "error" },
          },
          { subagent: { ...subagent, status: "failed" } }
        )}
      />
    )
    expect(await screen.findByText("Failed")).toBeInTheDocument()
    expect(screen.getByText("Check the pricing tiers")).toBeVisible()
  })

  it("localizes the subagent facts in Hebrew", async () => {
    render(
      <ToolUiLocaleProvider locale="he">
        <ToolUiSessionLinkProvider
          sessionLink={(id) => ({ href: `/s/${id}`, open: () => {} })}
        >
          <AosToolPresentation {...subagentPart} />
        </ToolUiSessionLinkProvider>
      </ToolUiLocaleProvider>
    )
    expect(await screen.findByText("עומק 1")).toBeInTheDocument()
    expect(screen.getByText("כתב קובץ אחד")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "פתיחת שיחה" })).toBeVisible()
  })
})
