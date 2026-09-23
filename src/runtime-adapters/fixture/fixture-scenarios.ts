import type { TodoItem } from "../contracts"
import { FIXTURE_ARTIFACT_CATALOG } from "./fixture-artifacts"
import type { ThreadMessage } from "@assistant-ui/react"
import { withAosToolArtifact } from "@/components/tool-ui/tool-artifact"

// Assistant UI's public type lives in @assistant-ui/react. Re-exporting a local
// alias keeps all fixture-only provider payloads inside this adapter directory.
import type {
  ThreadAssistantMessagePart as AssistantPart,
  MessageStatus,
} from "@assistant-ui/react"

export const fixtureScenarioNames = [
  "default",
  "question",
  "permission",
  "subagent",
  "todos",
  "chart",
  "map",
  "stats",
  "artifact",
  "image",
  "audio",
  "video",
  "mermaid",
  "mermaid-wide",
  "mermaid-incomplete",
  "mermaid-malformed",
  "mermaid-oversized",
  "malformed-tool",
  "provider-outage",
  "tool-kinds",
  "diff",
  "terminal-live",
  "terminal-failed",
  "subagent-nested",
  "stop-length",
  "stop-refusal",
  "provider-error-detail",
  "compaction",
  "compaction-failed",
] as const

export type FixtureScenarioName = (typeof fixtureScenarioNames)[number]

/** Shape carried by the question scenario; the chat model uses it to register a pending request. */
export type FixtureQuestionTemplate = {
  /** The question's words; the preview offers no short label, as clarify does not. */
  prompt: string
  options: readonly string[]
  allowFreeform: boolean
}

export type FixtureScenario = {
  name: FixtureScenarioName
  parts: AssistantPart[]
  todoEvent?: TodoItem[]
  outage?: Error
  /** Snapshots streamed before `parts`, one fixture tick apart. */
  frames?: AssistantPart[][]
  /** How the turn settles when it is not an ordinary completion. */
  status?: MessageStatus
  /** Present on the question scenario; drives the RuntimeInteractionAdapter registration. */
  questionTemplate?: FixtureQuestionTemplate
}

function toolPart(
  toolName: string,
  args: Extract<AssistantPart, { type: "tool-call" }>["args"],
  result?: unknown,
  extra: Partial<Extract<AssistantPart, { type: "tool-call" }>> = {}
): Extract<AssistantPart, { type: "tool-call" }> {
  return {
    type: "tool-call",
    toolCallId: `fixture-${toolName}`,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    ...extra,
  }
}

const FIXTURE_README_PATCH = [
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,3 +1,4 @@",
  " # Market brief",
  "-Draft",
  "+Reviewed",
  "+Sources are listed below.",
].join("\n")

/** A turn that edits a file, compacts its context, and keeps going. */
function compactionParts(compaction: Record<string, unknown>): AssistantPart[] {
  return [
    toolPart("read_file", { path: "README.md" }, "# Market brief\nDraft", {
      artifact: withAosToolArtifact(undefined, { kind: "read" }),
    }),
    toolPart("edit_file", { path: "README.md" }, "updated", {
      artifact: withAosToolArtifact(undefined, {
        kind: "edit",
        locations: [{ path: "README.md" }],
        diffs: [
          {
            changes: [{ kind: "modify", path: "README.md" }],
            patch: FIXTURE_README_PATCH,
          },
        ],
      }),
    }),
    { type: "data", name: "aos-compaction", data: compaction } as AssistantPart,
    toolPart("run_command", { command: "bun run test" }, "12 passed", {
      artifact: withAosToolArtifact(undefined, { kind: "execute" }),
    }),
    { type: "text", text: "The brief is reviewed and its tests pass." },
  ]
}

const FIXTURE_TOOL_STARTED_AT = Date.UTC(2026, 8, 1, 9, 0, 0)

/** A call that ran `ms` from the fixture's fixed clock. */
function fixtureTiming(ms: number) {
  return {
    startedAt: FIXTURE_TOOL_STARTED_AT,
    completedAt: FIXTURE_TOOL_STARTED_AT + ms,
  }
}

const FIXTURE_MULTI_FILE_PATCH = [
  "diff --git a/src/pricing/tiers.ts b/src/pricing/tiers.ts",
  "--- a/src/pricing/tiers.ts",
  "+++ b/src/pricing/tiers.ts",
  "@@ -1,3 +1,4 @@",
  ' export const tiers = ["starter", "team"]',
  "-export const trialDays = 14",
  "+export const trialDays = 30",
  '+export const enterprise = "contact sales"',
  ' export const currency = "USD"',
  "diff --git a/src/pricing/tiers.test.ts b/src/pricing/tiers.test.ts",
  "--- a/src/pricing/tiers.test.ts",
  "+++ b/src/pricing/tiers.test.ts",
  "@@ -3,3 +3,4 @@",
  ' it("offers a trial", () => {',
  "-  expect(trialDays).toBe(14)",
  "+  expect(trialDays).toBe(30)",
  "+  expect(enterprise).toBeTruthy()",
  " })",
].join("\n")

const FIXTURE_TEST_OUTPUT = [
  "\u001b[1m$ bun run test src/pricing\u001b[0m",
  " ✓ src/pricing/tiers.test.ts (3)",
  " ✓ src/pricing/discounts.test.ts (5)",
  " ✓ src/pricing/currency.test.ts (2)",
  "",
  " Test Files  3 passed (3)",
  "      Tests  10 passed (10)",
]

/** The terminal-live call as its output arrives, line by line. */
function liveTerminalPart(
  lines: number
): Extract<AssistantPart, { type: "tool-call" }> {
  const done = lines >= FIXTURE_TEST_OUTPUT.length
  return toolPart(
    "run_command",
    { command: "bun run test src/pricing" },
    done ? "10 passed" : undefined,
    {
      artifact: withAosToolArtifact(undefined, {
        kind: "execute",
        terminals: [
          {
            terminalId: "fixture-terminal-live",
            command: "bun run test src/pricing",
            cwd: "/workspace/market-brief",
            output: FIXTURE_TEST_OUTPUT.slice(0, lines).join("\n"),
            running: !done,
            ...(done ? { exitCode: 0 } : {}),
          },
        ],
      }),
      // A live frame carries no start: the fixed fixture clock is long past.
      ...(done ? { timing: fixtureTiming(4200) } : {}),
    }
  )
}

/** A subagent's own conversation, as nested thread messages. */
function nestedSubagentMessages(): ThreadMessage[] {
  const createdAt = new Date(FIXTURE_TOOL_STARTED_AT)
  return [
    {
      id: "fixture-subagent-user",
      role: "user",
      createdAt,
      content: [
        {
          type: "text",
          text: "Check the pricing tiers against the interview notes.",
        },
      ],
      attachments: [],
      metadata: { custom: {} },
    },
    {
      id: "fixture-subagent-assistant",
      role: "assistant",
      createdAt,
      status: { type: "complete", reason: "stop" },
      content: [
        {
          type: "text",
          text: "Two of three tiers match what buyers asked for; the team tier needs a longer trial.",
        },
      ],
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    },
  ]
}

export function buildFixtureScenario(prompt: string): FixtureScenario {
  const input = prompt.toLocaleLowerCase("en")

  if (input.includes("compaction") || input.includes("compact")) {
    return input.includes("fail")
      ? {
          name: "compaction-failed",
          parts: compactionParts({
            compactionId: "fixture-compaction-failed",
            status: "failed",
            error: "The summarizer timed out after 30 s.",
          }),
        }
      : {
          name: "compaction",
          parts: compactionParts({
            compactionId: "fixture-compaction",
            status: "completed",
            summary:
              "The operator asked for a reviewed market brief. README.md now reads Reviewed and lists its sources; the test run is next.",
          }),
        }
  }

  if (input.includes("length limit") || input.includes("truncat")) {
    return {
      name: "stop-length",
      parts: [
        toolPart("read_file", { path: "notes/interviews.md" }, "contents"),
        {
          type: "text",
          text: "The interviews agree on three themes. First, buyers want governance before scale. Second, pilots stall without an owner. Third,",
        },
      ],
      status: { type: "incomplete", reason: "length" },
    }
  }

  if (input.includes("refus") || input.includes("declin")) {
    return {
      name: "stop-refusal",
      parts: [
        toolPart("read_file", { path: "notes/request.md" }, "contents"),
        { type: "text", text: "I can’t help with that part of the request." },
      ],
      status: { type: "incomplete", reason: "content-filter" },
    }
  }

  if (input.includes("provider error")) {
    return {
      name: "provider-error-detail",
      parts: [{ type: "text", text: "The partial response is preserved." }],
      status: {
        type: "incomplete",
        reason: "error",
        error: {
          code: "AOS_PROVIDER_RUN_FAILED",
          message: "The upstream model returned 529 (overloaded).",
          provider: "Fixture Cloud",
          model: "fixture-balanced",
        },
      },
    }
  }

  if (input.includes("outage") || input.includes("disconnect")) {
    return {
      name: "provider-outage",
      parts: [{ type: "text", text: "The partial response is preserved." }],
      outage: new Error("Fixture provider unavailable"),
    }
  }

  if (input.includes("question")) {
    return {
      name: "question",
      parts: [
        toolPart("ask_user_question", {
          question: "Which audience should the brief prioritize?",
          options: ["Executive team", "Product team", "Investors"],
          allowFreeform: true,
        }),
      ],
      questionTemplate: {
        prompt: "Which audience should the brief prioritize?",
        options: ["Executive team", "Product team", "Investors"],
        allowFreeform: true,
      },
    }
  }

  if (input.includes("permission") || input.includes("approval")) {
    return {
      name: "permission",
      parts: [
        toolPart(
          "request_permission",
          { action: "Read the shared market dataset" },
          undefined,
          {
            approval: {
              id: "approval-market-data",
              prompt: "Allow Aster to read the shared market dataset?",
              options: [
                { id: "once", kind: "allow-once", label: "Allow once" },
                {
                  id: "always-dataset",
                  kind: "allow-always",
                  label: "Always for this dataset",
                  grants: ["datasets/market/**"],
                },
                { id: "reject", kind: "reject-once", label: "Reject" },
              ],
            },
          }
        ),
      ],
    }
  }

  if (input.includes("tool kinds") || input.includes("tool kind")) {
    return {
      name: "tool-kinds",
      parts: [
        toolPart("view_source", { path: "src/pricing/tiers.ts" }, "contents", {
          artifact: withAosToolArtifact(undefined, {
            kind: "read",
            locations: [{ path: "src/pricing/tiers.ts", line: 12 }],
          }),
          timing: fixtureTiming(320),
        }),
        toolPart("grep_workspace", { pattern: "trialDays" }, "3 matches", {
          artifact: withAosToolArtifact(undefined, {
            kind: "search",
            locations: [
              { path: "src/pricing/tiers.ts", line: 2 },
              { path: "src/pricing/tiers.test.ts", line: 4 },
              { path: "docs/pricing.md", line: 18 },
            ],
          }),
          timing: fixtureTiming(1400),
        }),
        toolPart("remove_path", { path: "notes/draft-pricing.md" }, "removed", {
          artifact: withAosToolArtifact(undefined, {
            kind: "delete",
            locations: [{ path: "notes/draft-pricing.md" }],
          }),
        }),
        toolPart(
          "rename_path",
          { source: "notes/brief.md", destination: "docs/brief.md" },
          "moved",
          {
            artifact: withAosToolArtifact(undefined, {
              kind: "move",
              locations: [
                { path: "notes/brief.md" },
                { path: "docs/brief.md" },
              ],
            }),
          }
        ),
        toolPart("http_get", { url: "https://example.com/pricing" }, "200 OK", {
          artifact: withAosToolArtifact(undefined, { kind: "fetch" }),
          timing: fixtureTiming(2600),
        }),
        toolPart("plan_step", { title: "Compare tiers" }, "noted", {
          artifact: withAosToolArtifact(undefined, { kind: "think" }),
        }),
        toolPart("set_mode", { mode: "review" }, "review", {
          artifact: withAosToolArtifact(undefined, { kind: "switch_mode" }),
        }),
        toolPart("lookup_currency", { name: "USD" }, "1.00", {
          artifact: withAosToolArtifact(undefined, { kind: "other" }),
        }),
        { type: "text", text: "The pricing notes are reviewed." },
      ],
    }
  }

  if (input.includes("diff")) {
    return {
      name: "diff",
      parts: [
        toolPart(
          "apply_patch",
          { path: "src/pricing/tiers.ts" },
          "2 files updated",
          {
            artifact: withAosToolArtifact(undefined, {
              kind: "edit",
              locations: [
                { path: "src/pricing/tiers.ts" },
                { path: "src/pricing/tiers.test.ts" },
              ],
              diffs: [
                {
                  changes: [
                    { kind: "modify", path: "src/pricing/tiers.ts" },
                    { kind: "modify", path: "src/pricing/tiers.test.ts" },
                  ],
                  patch: FIXTURE_MULTI_FILE_PATCH,
                },
              ],
            }),
            timing: fixtureTiming(900),
          }
        ),
        toolPart(
          "move_assets",
          { source: "assets/old-logo.svg" },
          "3 files changed",
          {
            artifact: withAosToolArtifact(undefined, {
              kind: "edit",
              locations: [{ path: "assets/logo.svg" }],
              diffs: [
                {
                  changes: [
                    {
                      kind: "move",
                      path: "assets/logo.svg",
                      oldPath: "assets/old-logo.svg",
                    },
                    { kind: "add", path: "assets/logo-dark.svg" },
                    { kind: "delete", path: "assets/logo-legacy.png" },
                  ],
                },
              ],
            }),
          }
        ),
        {
          type: "text",
          text: "The trial is now 30 days and the logos are tidied.",
        },
      ],
    }
  }

  if (input.includes("terminal") && input.includes("fail")) {
    return {
      name: "terminal-failed",
      parts: [
        toolPart("run_command", { command: "bun run lint" }, "exit 1", {
          isError: true,
          artifact: withAosToolArtifact(undefined, {
            kind: "execute",
            terminals: [
              {
                terminalId: "fixture-terminal-failed",
                command: "bun run lint",
                cwd: "/workspace/market-brief",
                output: [
                  "$ eslint src",
                  "src/pricing/tiers.ts",
                  "  4:14  error  'enterprise' is assigned a value but never used  no-unused-vars",
                  "",
                  "✖ 1 problem (1 error, 0 warnings)",
                ].join("\n"),
                running: false,
                exitCode: 1,
              },
            ],
          }),
          timing: fixtureTiming(3100),
        }),
        {
          type: "text",
          text: "Lint found one unused export; I will remove it next.",
        },
      ],
    }
  }

  if (input.includes("terminal")) {
    const steps = FIXTURE_TEST_OUTPUT.length
    return {
      name: "terminal-live",
      frames: Array.from({ length: steps }, (_, index) => [
        liveTerminalPart(index + 1),
      ]),
      parts: [
        liveTerminalPart(steps),
        { type: "text", text: "All ten pricing tests pass." },
      ],
    }
  }

  if (input.includes("nested subagent") || input.includes("subagent nested")) {
    return {
      name: "subagent-nested",
      parts: [
        toolPart(
          "spawn_agent",
          { task: "Check the pricing tiers against the interviews" },
          "Two of three tiers match.",
          {
            artifact: withAosToolArtifact(undefined, {
              kind: "other",
              subagent: {
                id: "fixture-subagent",
                goal: "Check the pricing tiers against the interviews",
                model: "claude-opus-5.5",
                depth: 1,
                status: "completed",
                tokens: 18_400,
                durationMs: 72_000,
                filesRead: [
                  "src/pricing/tiers.ts",
                  "notes/interviews.md",
                  "docs/pricing.md",
                ],
                filesWritten: ["notes/pricing-review.md"],
                childSessionId: "fixture-subagent-session",
              },
            }),
            messages: nestedSubagentMessages(),
          }
        ),
        { type: "text", text: "The team tier needs a longer trial." },
      ],
    }
  }

  if (input.includes("subagent")) {
    return {
      name: "subagent",
      parts: [
        toolPart(
          "delegate_subagent",
          { task: "Validate the market segments" },
          {
            name: "Data analyst",
            status: "completed",
            summary: "Validated three segments against the fixture dataset.",
          }
        ),
      ],
    }
  }

  if (input.includes("todo")) {
    return {
      name: "todos",
      parts: [{ type: "text", text: "I updated the execution tasks." }],
      todoEvent: [
        { id: "todo-fixture-1", label: "Review the result", status: "active" },
      ],
    }
  }

  if (input.includes("chart")) {
    return {
      name: "chart",
      parts: [
        toolPart(
          "render_chart",
          {
            title: "Enterprise AI spend",
            type: "line",
            xKey: "quarter",
            series: [
              { key: "total", label: "Total AI spend" },
              { key: "genai", label: "GenAI spend" },
            ],
            data: [
              { quarter: "Q4’24", total: 300, genai: 220 },
              { quarter: "Q1’25", total: 365, genai: 275 },
            ],
          },
          { ok: true }
        ),
      ],
    }
  }

  if (input.includes("map")) {
    return {
      name: "map",
      parts: [
        toolPart(
          "render_map",
          {
            title: "Interview coverage",
            locations: [
              {
                id: "london",
                label: "London",
                latitude: 51.5072,
                longitude: -0.1276,
              },
              {
                id: "tel-aviv",
                label: "Tel Aviv",
                latitude: 32.0853,
                longitude: 34.7818,
              },
            ],
          },
          { ok: true }
        ),
      ],
    }
  }

  if (input.includes("stat") || input.includes("metric")) {
    return {
      name: "stats",
      parts: [
        toolPart(
          "render_stats",
          {
            title: "Launch metrics",
            description: "Illustrative execution metrics",
            stats: [
              {
                key: "sessions",
                label: "Sessions",
                value: 1284,
                format: { kind: "number", compact: true },
                diff: { value: 12.5, label: "vs. last week" },
                sparkline: { data: [880, 940, 1012, 1090, 1160, 1284] },
              },
              {
                key: "completion",
                label: "Completion",
                value: 0.74,
                format: { kind: "percent", decimals: 0 },
                diff: { value: 4.1 },
              },
            ],
          },
          { ok: true }
        ),
      ],
    }
  }

  if (input.includes("audio")) {
    return {
      name: "audio",
      parts: [
        {
          type: "data",
          name: "aos.artifact",
          data: FIXTURE_ARTIFACT_CATALOG.examples.audio,
        } as AssistantPart,
      ],
    }
  }

  if (input.includes("video")) {
    return {
      name: "video",
      parts: [
        {
          type: "data",
          name: "aos.artifact",
          data: FIXTURE_ARTIFACT_CATALOG.examples.video,
        } as AssistantPart,
      ],
    }
  }

  if (input.includes("image")) {
    return {
      name: "image",
      parts: [
        {
          type: "data",
          name: "aos.artifact",
          data: FIXTURE_ARTIFACT_CATALOG.examples.image,
        } as AssistantPart,
      ],
    }
  }

  if (input.includes("artifact") || input.includes("deliverable")) {
    return {
      name: "artifact",
      parts: [
        {
          type: "data",
          name: "aos.artifact",
          data: FIXTURE_ARTIFACT_CATALOG.examples.markdown,
        } as AssistantPart,
      ],
    }
  }

  if (input.includes("mermaid")) {
    if (input.includes("incomplete") || input.includes("stream")) {
      return {
        name: "mermaid-incomplete",
        parts: [
          {
            type: "text",
            text: "```mermaid\nflowchart LR\n  Request -->",
          },
        ],
      }
    }

    if (input.includes("malformed")) {
      return {
        name: "mermaid-malformed",
        parts: [
          {
            type: "text",
            text: "```mermaid\nflowchart LR\n  Request -->\n```",
          },
        ],
      }
    }

    if (input.includes("oversized") || input.includes("too large")) {
      return {
        name: "mermaid-oversized",
        parts: [
          {
            type: "text",
            text: `\`\`\`mermaid\nflowchart LR\n${"  A\n".repeat(401)}\`\`\``,
          },
        ],
      }
    }

    if (input.includes("wide") || input.includes("large")) {
      return {
        name: "mermaid-wide",
        parts: [
          {
            type: "text",
            text: "```mermaid\nflowchart LR\n  Intake[Intake the request] --> Triage[Triage and classify]\n  Triage --> Research[Research the sources]\n  Research --> Draft[Draft the answer]\n  Draft --> Review[Review for accuracy]\n  Review --> Publish[Publish the brief]\n  Publish --> Archive[Archive the record]\n```",
          },
        ],
      }
    }

    return {
      name: "mermaid",
      parts: [
        {
          type: "text",
          text: "```mermaid\nflowchart LR\n  Request --> Plan\n  Plan --> Result\n```",
        },
      ],
    }
  }

  if (input.includes("malformed")) {
    return {
      name: "malformed-tool",
      parts: [
        toolPart(
          "unknown_fixture_tool",
          { unexpected: [null, 42] },
          "not-an-object"
        ),
      ],
    }
  }

  return {
    name: "default",
    parts: [
      {
        type: "text",
        text: "Enterprise AI spend continues to broaden and deepen. I’ll keep the analysis focused and show execution details only when they help.",
      },
    ],
  }
}
