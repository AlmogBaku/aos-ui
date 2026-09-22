import { describe, expect, it } from "vitest"

import { enToolUiLabels, heToolUiLabels } from "@/components/tool-ui/locale"
import {
  createTurnGroupBy,
  describeToolRun,
  formatTurnDuration,
  turnLayout,
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

  it("counts one kind, singular and plural", () => {
    expect(describeToolRun(["read_file"], en, "en")).toBe("Read 1 file")
    expect(describeToolRun(["read_file", "read_doc"], en, "en")).toBe(
      "Read 2 files"
    )
  })

  it("keeps the kinds in the order they first appeared", () => {
    expect(
      describeToolRun(
        ["terminal", "read_file", "terminal", "apply_patch"],
        en,
        "en"
      )
    ).toBe("Ran 2 commands, read 1 file, and changed 1 file")
  })

  it("separates a web search from a code search", () => {
    expect(describeToolRun(["grep"], en, "en")).toBe("Searched code once")
    expect(describeToolRun(["web_search", "web_search"], en, "en")).toBe(
      "Searched the web 2 times"
    )
  })

  it("names skills, delegation, inspection and unknown tools", () => {
    expect(
      describeToolRun(
        ["use_skill", "delegate_subagent", "tool_describe", "provider_tool"],
        en,
        "en"
      )
    ).toBe("Loaded 1 skill, delegated 1 task, inspected once, and used 1 tool")
  })

  it("describes the same run in Hebrew", () => {
    expect(describeToolRun(["read_file", "read_doc"], he, "he")).toBe(
      "קרא 2 קבצים"
    )
    expect(describeToolRun(["terminal", "web_search"], he, "he")).toBe(
      "הריץ פקודה אחת וחיפש ברשת פעם אחת"
    )
  })

  it("says nothing about an empty run", () => {
    expect(describeToolRun([], en, "en")).toBe("")
  })
})

describe("formatTurnDuration", () => {
  const en = enToolUiLabels.assistant.duration
  const he = heToolUiLabels.assistant.duration

  it("rounds to whole seconds under a minute", () => {
    expect(formatTurnDuration(29_400, en)).toBe("29 s")
    expect(formatTurnDuration(29_400, he)).toBe("29 שנ׳")
  })

  it("splits a longer turn into minutes and seconds", () => {
    expect(formatTurnDuration(65_000, en)).toBe("1 min 5 s")
    expect(formatTurnDuration(65_000, he)).toBe("1 דק׳ 5 שנ׳")
    expect(formatTurnDuration(120_000, en)).toBe("2 min")
  })
})
