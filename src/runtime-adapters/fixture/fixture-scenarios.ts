import type { TodoItem } from "../contracts"
import { FIXTURE_ARTIFACT_CATALOG } from "./fixture-artifacts"

// Assistant UI's public type lives in @assistant-ui/react. Re-exporting a local
// alias keeps all fixture-only provider payloads inside this adapter directory.
import type { ThreadAssistantMessagePart as AssistantPart } from "@assistant-ui/react"

export const fixtureScenarioNames = [
  "default",
  "question",
  "permission",
  "subagent",
  "plan",
  "todos",
  "chart",
  "map",
  "stats",
  "artifact",
  "image",
  "mermaid",
  "mermaid-incomplete",
  "mermaid-malformed",
  "mermaid-oversized",
  "monty-success",
  "monty-failure",
  "malformed-tool",
  "provider-outage",
] as const

export type FixtureScenarioName = (typeof fixtureScenarioNames)[number]

export type FixtureScenario = {
  name: FixtureScenarioName
  parts: AssistantPart[]
  todoEvent?: TodoItem[]
  outage?: Error
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

export function buildFixtureScenario(prompt: string): FixtureScenario {
  const input = prompt.toLocaleLowerCase("en")

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

  if (input.includes("plan")) {
    return {
      name: "plan",
      parts: [
        toolPart(
          "present_plan",
          { title: "Market brief" },
          {
            id: "plan-market",
            title: "Plan",
            steps: [
              {
                id: "scope",
                label: "Define scope and coverage",
                status: "completed",
              },
              {
                id: "trends",
                label: "Aggregate spend trends",
                status: "active",
              },
              {
                id: "segments",
                label: "Segment by function and industry",
                status: "pending",
              },
              {
                id: "drivers",
                label: "Identify drivers and shifts",
                status: "pending",
              },
              {
                id: "summary",
                label: "Summarize key takeaways",
                status: "pending",
              },
            ],
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
          { title: "Enterprise AI spend" },
          {
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
          }
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
          { title: "Interview coverage" },
          {
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
          }
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
          { title: "Launch metrics" },
          {
            id: "fixture-launch-metrics",
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
          }
        ),
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

  if (input.includes("monty") && input.includes("fail")) {
    return {
      name: "monty-failure",
      parts: [
        toolPart(
          "monty_execute",
          { code: "fetch_market()" },
          { error: "Fixture Monty execution failed" },
          { isError: true, toolCallId: "fixture-monty_execute-failure" }
        ),
      ],
    }
  }

  if (input.includes("monty")) {
    return {
      name: "monty-success",
      parts: [
        toolPart(
          "monty_execute",
          { code: "market.total_by_quarter()" },
          { stdout: "Q1’25: 365", receipt: "fixture-monty-001" },
          { toolCallId: "fixture-monty_execute-success" }
        ),
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
