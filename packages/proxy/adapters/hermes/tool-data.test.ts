import { describe, expect, it } from "vitest"

import {
  canonicalToolArgs,
  canonicalToolName,
  projectHermesToolCall,
  projectHermesToolOutcome,
  unwrapToolCall,
} from "./tool-data"

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

describe("unwrapToolCall", () => {
  it("unwraps a tool-search bridge call into the selected tool", () => {
    expect(
      unwrapToolCall("tool_call", {
        name: "read_file",
        arguments: '{"path":"report.txt"}',
      })
    ).toEqual({ name: "read_file", args: { path: "report.txt" } })
  })

  it("parses a serialized argument envelope", () => {
    expect(
      unwrapToolCall(
        "tool_call",
        JSON.stringify({ name: "read_file", arguments: '{"path":"a.txt"}' })
      )
    ).toEqual({ name: "read_file", args: { path: "a.txt" } })
  })

  it("keeps the envelope when the selected payload exceeds the bounded size", () => {
    const selected = JSON.stringify({ note: "x".repeat(70_000) })
    expect(
      unwrapToolCall("tool_call", { name: "read_file", arguments: selected })
    ).toEqual({
      name: "tool_call",
      args: { name: "read_file", arguments: selected },
    })
  })

  it("unwraps a selection Hermes recorded as a nested object", () => {
    expect(
      unwrapToolCall("tool_call", {
        name: "read_file",
        arguments: { path: "a" },
      })
    ).toEqual({ name: "read_file", args: { path: "a" } })
  })

  it("keeps the envelope for a non-record or unnamed selection", () => {
    expect(
      unwrapToolCall("tool_call", { name: "read_file", arguments: "[1,2]" })
    ).toEqual({
      name: "tool_call",
      args: { name: "read_file", arguments: "[1,2]" },
    })
    expect(
      unwrapToolCall("tool_call", { name: "  ", arguments: "{}" })
    ).toEqual({ name: "tool_call", args: { name: "  ", arguments: "{}" } })
    expect(
      unwrapToolCall("tool_call", { name: "read_file", arguments: "{oops" })
    ).toEqual({
      name: "tool_call",
      args: { name: "read_file", arguments: "{oops" },
    })
  })

  it("returns an ordinary call and coerces a non-record payload to empty args", () => {
    expect(unwrapToolCall("read_file", { path: "a.txt" })).toEqual({
      name: "read_file",
      args: { path: "a.txt" },
    })
    expect(unwrapToolCall("read_file", [1, 2])).toEqual({
      name: "read_file",
      args: {},
    })
    expect(unwrapToolCall("read_file", undefined)).toEqual({
      name: "read_file",
      args: {},
    })
  })
})

describe("canonicalToolArgs", () => {
  it("adds the delegate description fallback from the first descriptive field", () => {
    expect(
      canonicalToolArgs("delegate_task", { goal: "Inspect the ledger" })
    ).toEqual({
      goal: "Inspect the ledger",
      description: "Inspect the ledger",
    })
    expect(
      canonicalToolArgs("delegate_subagent", { goals: ["  Audit  "] })
    ).toEqual({ goals: ["  Audit  "], description: "Audit" })
    expect(
      canonicalToolArgs("delegate_task", {
        description: "Given",
        prompt: "Ignored",
      })
    ).toEqual({ description: "Given", prompt: "Ignored" })
  })

  it("normalizes a single clarify question into the renderable question shape", () => {
    expect(
      canonicalToolArgs("clarify", {
        question: "Pick one",
        choices: ["A", "B"],
        multi_select: true,
      })
    ).toEqual({
      question: "Pick one",
      options: ["A", "B"],
      allowFreeform: false,
      multiple: true,
    })
    expect(
      canonicalToolArgs("clarify", { question: "Anything else?" })
    ).toEqual({
      question: "Anything else?",
      allowFreeform: true,
      multiple: false,
    })
  })

  it("normalizes a batched clarify request into one summary question", () => {
    expect(
      canonicalToolArgs("clarify", {
        questions: [
          {
            question: "Where?",
            choices: ["Here", "There"],
            multi_select: false,
          },
          { question: "When?" },
        ],
      })
    ).toEqual({
      question: "2 questions",
      questions: [
        {
          question: "Where?",
          options: ["Here", "There"],
          allowFreeform: false,
          multiple: false,
        },
        { question: "When?", allowFreeform: true, multiple: false },
      ],
      allowFreeform: true,
    })
  })

  it("leaves an unrelated tool's arguments untouched", () => {
    expect(canonicalToolArgs("read_file", { path: "a.txt" })).toEqual({
      path: "a.txt",
    })
  })
})

describe("projectHermesToolCall", () => {
  it("projects the canonical public name and arguments", () => {
    expect(projectHermesToolCall("delegate_task", { goal: "Inspect" })).toEqual(
      {
        toolName: "delegate_subagent",
        args: { goal: "Inspect", description: "Inspect" },
      }
    )
  })

  it("keeps only the public artifact identity fields for present_artifact", () => {
    expect(
      projectHermesToolCall("present_artifact", {
        id: "report-1",
        title: "Report",
        path: "/srv/hermes/private/report.md",
        sizeBytes: 42,
      })
    ).toEqual({
      toolName: "present_artifact",
      args: { id: "report-1", title: "Report", sizeBytes: 42 },
    })
  })

  it("never carries provider session metadata or credentials into the public args", () => {
    expect(
      projectHermesToolCall("run_command", {
        command: "deploy",
        apiKey: "sk-live-abcdef",
        liveSessionId: "live-secret",
      }).args
    ).toEqual({ command: "deploy", apiKey: "[REDACTED]" })
  })
})

describe("projectHermesToolOutcome", () => {
  it("classifies a semantic failure envelope and the native flag alike", () => {
    expect(
      projectHermesToolOutcome("call-1", "read_file", { success: false })
        .isError
    ).toBe(true)
    expect(
      projectHermesToolOutcome("call-1", "read_file", "contents", true).isError
    ).toBe(true)
    expect(
      projectHermesToolOutcome("call-1", "read_file", "contents").isError
    ).toBe(false)
  })

  it("publishes an artifact receipt as one public descriptor part", () => {
    const outcome = projectHermesToolOutcome("call-2", "present_artifact", {
      ok: true,
      type: "aos.artifact",
      artifact: {
        id: "report-1",
        filename: "report.md",
        path: "/srv/hermes/private/report.md",
        mimeType: "text/markdown",
      },
    })
    expect(outcome.result).toEqual({
      ok: true,
      type: "aos.artifact",
      artifact: {
        id: "report-1",
        filename: "report.md",
        mimeType: "text/markdown",
      },
    })
    expect(outcome.parts).toEqual([
      {
        type: "data",
        name: "aos.artifact",
        data: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          source: { type: "provider", reference: "report-1" },
        },
      },
    ])
    expect(JSON.stringify(outcome)).not.toContain("/srv/hermes")
  })

  it("collapses an unpublishable artifact receipt to its status fields", () => {
    const outcome = projectHermesToolOutcome("call-3", "present_artifact", {
      ok: true,
      type: "aos.artifact",
      artifact: { id: "/srv/private/report.md", filename: "../report.md" },
    })
    expect(outcome.result).toEqual({ ok: true })
    expect(outcome.parts).toEqual([])
    expect(JSON.stringify(outcome)).not.toContain("/srv/private")
  })

  it("drops an artifact receipt message that names a private location", () => {
    const outcome = projectHermesToolOutcome("call-3b", "present_artifact", {
      ok: false,
      status: "failed",
      message: "Could not write /home/alice/reports/report.md",
    })
    expect(outcome.result).toEqual({ ok: false, status: "failed" })
    expect(JSON.stringify(outcome)).not.toContain("/home/alice")
  })

  it("collapses a text_to_speech receipt to a status and trusts its media", () => {
    const audio = "/home/alice/voice/brief.mp3"
    const outcome = projectHermesToolOutcome("call-4", "text_to_speech", {
      success: true,
      file_path: audio,
      file_paths: [audio],
      media_tag: `MEDIA:${audio}`,
    })
    expect(outcome.result).toEqual({ status: "completed" })
    expect(outcome.trustedMedia).toEqual([audio])
    expect(outcome.parts).toMatchObject([
      {
        type: "data",
        name: "aos.artifact",
        data: { filename: "brief.mp3", mimeType: "audio/mpeg" },
      },
    ])
    expect(
      projectHermesToolOutcome("call-5", "text_to_speech", {
        success: false,
        error: "voice unavailable",
      })
    ).toMatchObject({
      isError: true,
      result: { status: "failed" },
      parts: [],
      trustedMedia: [],
    })
  })

  it("projects recorded question answers and redacts a credential-shaped answer", () => {
    expect(
      projectHermesToolOutcome("call-6", "question", {
        responses: [
          {
            question: "Where do you live?",
            user_response: JSON.stringify(["Jerusalem"]),
          },
        ],
      }).result
    ).toEqual({
      status: "answered",
      responses: [{ question: "Where do you live?", answers: ["Jerusalem"] }],
    })
    expect(
      projectHermesToolOutcome("call-7", "question", {
        responses: [
          {
            question: "Which token?",
            user_response: JSON.stringify(["api_key=sk-live-abcdef"]),
          },
        ],
      }).result
    ).toEqual({
      status: "cancelled",
      responses: [{ question: "Which token?", answers: [] }],
    })
  })

  it("keeps every chosen value of a multi-select answer Hermes records as a list", () => {
    expect(
      projectHermesToolOutcome("call-6b", "question", {
        responses: [
          {
            question: "Which areas do you want included?",
            user_response: ["Content", "Pipeline"],
          },
          {
            question: "What would make this week a win?",
            user_response: "",
          },
        ],
      }).result
    ).toEqual({
      status: "answered",
      responses: [
        {
          question: "Which areas do you want included?",
          answers: ["Content", "Pipeline"],
        },
        { question: "What would make this week a win?", answers: [] },
      ],
    })
  })

  it("suppresses artifacts and media on a failed tool", () => {
    const outcome = projectHermesToolOutcome(
      "call-8",
      "present_artifact",
      {
        ok: true,
        type: "aos.artifact",
        artifact: { id: "a", filename: "a.md" },
      },
      true
    )
    expect(outcome.isError).toBe(true)
    expect(outcome.parts).toEqual([])
  })
})
