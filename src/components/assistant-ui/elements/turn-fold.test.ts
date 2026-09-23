import { describe, expect, it } from "vitest"

import { enToolUiLabels, heToolUiLabels } from "@/components/tool-ui/locale"
import {
  withAosToolArtifact,
  type AosToolKind,
} from "@/components/tool-ui/tool-artifact"
import {
  createTurnGroupBy,
  describeToolRun,
  formatTurnDuration,
  turnLayout,
  turnOutcome,
  type TurnPart,
} from "./turn-fold"

const text = (text: string): TurnPart => ({ type: "text", text }) as TurnPart
const reasoning = (): TurnPart => ({ type: "reasoning" })
const tool = (toolName: string): TurnPart => ({ type: "tool-call", toolName })
const chart = (): TurnPart =>
  ({
    type: "tool-call",
    toolName: "render_chart",
    args: {
      title: "Trend",
      type: "line",
      xKey: "quarter",
      series: [{ key: "value", label: "Value" }],
      data: [{ quarter: "Q1", value: 12 }],
    },
  }) as TurnPart

const paths = (parts: readonly TurnPart[], status: string | undefined) => {
  const groupBy = createTurnGroupBy(parts, turnLayout(parts, status))
  return parts.map((part) => [...groupBy(part)])
}

describe("turnLayout", () => {
  it("folds nothing while the turn is still running", () => {
    const parts = [reasoning(), tool("read_file"), text("Partial answer")]

    expect(turnLayout(parts, "running")).toEqual({
      settled: false,
      terminalIndex: 2,
    })
  })

  it("folds nothing while the turn waits on the operator's answer", () => {
    const parts = [text("Let me write it."), tool("write_file")]

    expect(turnLayout(parts, "requires-action").settled).toBe(false)
  })

  it("finds the settled turn's answer in its last text part", () => {
    const parts = [
      text("Let me look."),
      tool("read_file"),
      text("The final answer."),
    ]

    expect(turnLayout(parts, "complete")).toEqual({
      settled: true,
      terminalIndex: 2,
    })
  })

  it("finds no answer in a turn that ended with no text", () => {
    const parts = [reasoning(), tool("read_file")]

    expect(turnLayout(parts, "incomplete")).toEqual({
      settled: true,
      terminalIndex: undefined,
    })
  })
})

describe("createTurnGroupBy", () => {
  it("groups consecutive ordinary tool calls and leaves a running turn in place", () => {
    const parts = [
      reasoning(),
      tool("read_file"),
      tool("web_search"),
      text("Streaming answer"),
    ]

    expect(paths(parts, "running")).toEqual([
      ["group-reasoning"],
      ["group-tool"],
      ["group-tool"],
      [],
    ])
  })

  it("folds the settled prefix and keeps the final answer outside it", () => {
    const parts = [
      reasoning(),
      tool("read_file"),
      text("Mid-turn note."),
      tool("apply_patch"),
      text("The final answer."),
    ]

    expect(paths(parts, "complete")).toEqual([
      ["group-working", "group-reasoning"],
      ["group-working", "group-tool"],
      ["group-working"],
      ["group-working", "group-tool"],
      [],
    ])
  })

  it("splits the fold around a first-class part instead of reordering it", () => {
    const parts = [
      tool("read_file"),
      chart(),
      tool("apply_patch"),
      text("The final answer."),
    ]

    expect(paths(parts, "complete")).toEqual([
      ["group-working", "group-tool"],
      [],
      ["group-working", "group-tool"],
      [],
    ])
  })

  it("folds work after the last prose into its own run after that prose", () => {
    const parts = [
      tool("read_file"),
      text("Scaffold generated. Verifying before wiring them."),
      reasoning(),
      tool("apply_patch"),
    ]

    expect(paths(parts, "complete")).toEqual([
      ["group-working", "group-tool"],
      [],
      ["group-working", "group-reasoning"],
      ["group-working", "group-tool"],
    ])
  })

  it("folds the whole trace of a turn that ended with no text", () => {
    const parts = [reasoning(), tool("read_file")]

    expect(paths(parts, "incomplete")).toEqual([
      ["group-working", "group-reasoning"],
      ["group-working", "group-tool"],
    ])
  })

  it("keeps a registered tool UI out of the fold", () => {
    const parts = [tool("provider_tool"), text("The final answer.")]
    const layout = turnLayout(parts, "complete")
    const groupBy = createTurnGroupBy(parts, layout)

    expect([...groupBy(parts[0]!, { toolUIs: { provider_tool: [] } })]).toEqual(
      []
    )
    expect([...groupBy(parts[0]!)]).toEqual(["group-working", "group-tool"])
  })
})

describe("describeToolRun", () => {
  const en = enToolUiLabels.assistant.toolRun
  const he = heToolUiLabels.assistant.toolRun
  const tools = (names: string[]) => names.map((toolName) => ({ toolName }))
  const kind = (kind: AosToolKind) => withAosToolArtifact(undefined, { kind })

  it("counts one kind, singular and plural", () => {
    expect(describeToolRun(tools(["read_file"]), en, "en")).toBe("Read 1 file")
    expect(describeToolRun(tools(["read_file", "read_doc"]), en, "en")).toBe(
      "Read 2 files"
    )
  })

  it("keeps the kinds in the order they first appeared", () => {
    expect(
      describeToolRun(
        tools(["terminal", "read_file", "terminal", "apply_patch"]),
        en,
        "en"
      )
    ).toBe("Ran 2 commands, read 1 file, and changed 1 file")
  })

  it("separates a web search from a code search", () => {
    expect(describeToolRun(tools(["grep"]), en, "en")).toBe(
      "Searched code once"
    )
    expect(describeToolRun(tools(["web_search", "web_search"]), en, "en")).toBe(
      "Searched the web 2 times"
    )
  })

  it("names skills, delegation, inspection and unknown tools", () => {
    expect(
      describeToolRun(
        tools([
          "use_skill",
          "delegate_subagent",
          "tool_describe",
          "provider_tool",
        ]),
        en,
        "en"
      )
    ).toBe("Loaded 1 skill, delegated 1 task, inspected once, and used 1 tool")
  })

  it("describes the same run in Hebrew", () => {
    expect(describeToolRun(tools(["read_file", "read_doc"]), he, "he")).toBe(
      "קרא 2 קבצים"
    )
    expect(describeToolRun(tools(["terminal", "web_search"]), he, "he")).toBe(
      "הריץ פקודה אחת וחיפש ברשת פעם אחת"
    )
  })

  it("counts by the provider's declared kind before the tool name", () => {
    expect(
      describeToolRun(
        [
          { toolName: "provider_tool", artifact: kind("edit") },
          { toolName: "provider_tool", artifact: kind("fetch") },
          { toolName: "read_file", artifact: kind("other") },
        ],
        en,
        "en"
      )
    ).toBe("Changed 1 file, searched the web once, and read 1 file")
  })

  it("says nothing about an empty run", () => {
    expect(describeToolRun(tools([]), en, "en")).toBe("")
  })
})

describe("formatTurnDuration", () => {
  const en = enToolUiLabels.assistant.duration
  const he = heToolUiLabels.assistant.duration

  it("rounds to whole seconds under a minute", () => {
    expect(formatTurnDuration(20_400, en)).toBe("20s")
    expect(formatTurnDuration(20_400, he)).toBe("20 שנ׳")
  })

  it("reads a longer turn in its two largest units", () => {
    expect(formatTurnDuration(1_047_000, en)).toBe("17m 27s")
    expect(formatTurnDuration(1_047_000, he)).toBe("17 דק׳ 27 שנ׳")
    expect(formatTurnDuration(120_000, en)).toBe("2m")
    expect(formatTurnDuration(3_900_000, en)).toBe("1h 5m")
    expect(formatTurnDuration(3_900_000, he)).toBe("1 שע׳ 5 דק׳")
  })
})

describe("turnOutcome", () => {
  it("names who ended the turn, keeping the existing outcomes", () => {
    expect(turnOutcome({ type: "complete", reason: "stop" })).toBe("worked")
    expect(turnOutcome({ type: "incomplete", reason: "cancelled" })).toBe(
      "stopped"
    )
    expect(turnOutcome({ type: "incomplete", reason: "error" })).toBe("failed")
    expect(turnOutcome({ type: "incomplete", reason: "length" })).toBe(
      "truncated"
    )
    expect(turnOutcome({ type: "incomplete", reason: "content-filter" })).toBe(
      "refused"
    )
  })
})
