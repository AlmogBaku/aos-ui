import { describe, expect, it } from "vitest"

import { canonicalToolName } from "./tool-data"

describe("canonicalToolName", () => {
  it("maps known aliases to their canonical names", () => {
    expect(canonicalToolName("delegate_task")).toBe("delegate_subagent")
    expect(canonicalToolName("skill_view")).toBe("use_skill")
    expect(canonicalToolName("todo_list")).toBe("todo")
    expect(canonicalToolName("clarify")).toBe("question")
  })

  it("returns unrecognised names unchanged", () => {
    expect(canonicalToolName("read_file")).toBe("read_file")
    expect(canonicalToolName("present_artifact")).toBe("present_artifact")
    expect(canonicalToolName("unknown_tool")).toBe("unknown_tool")
    expect(canonicalToolName("")).toBe("")
  })

  it("returns Object.prototype member names unchanged instead of the inherited value", () => {
    expect(canonicalToolName("constructor")).toBe("constructor")
    expect(canonicalToolName("toString")).toBe("toString")
    expect(canonicalToolName("__proto__")).toBe("__proto__")
    expect(canonicalToolName("hasOwnProperty")).toBe("hasOwnProperty")
    expect(canonicalToolName("valueOf")).toBe("valueOf")
  })
})
