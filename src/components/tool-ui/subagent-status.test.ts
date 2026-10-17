import { describe, expect, it } from "vitest"

import { withAosToolArtifact } from "@/lib/tool-artifact"

import { enToolUiLabels, heToolUiLabels } from "./locale"
import { subagentLiveLine } from "./subagent-status"

type Part = { type: string; text?: string; toolName?: string }

const said = (text: string): Part => ({ type: "text", text })
const called = (
  toolName: string,
  extra: { artifact?: unknown; result?: unknown } = {}
): Part => ({ type: "tool-call", toolName, ...extra })
const turn = (...content: Part[]) => ({ role: "assistant", content })
const brief = { role: "user", content: [said("Reconcile the invoices.")] }

describe("subagentLiveLine", () => {
  it.each([
    [
      "the last sentence the child wrote",
      [brief, turn(said("Invoices 1 to 20 match. Checking 21 to 48 now."))],
      enToolUiLabels,
      "Checking 21 to 48 now.",
    ],
    [
      "the kind and name of a call still running",
      [
        brief,
        turn(
          said("Reading the pricing pages."),
          called("web_extract", {
            artifact: withAosToolArtifact(undefined, { kind: "fetch" }),
          })
        ),
      ],
      enToolUiLabels,
      "Fetching web_extract",
    ],
    [
      "a finished call by what it did",
      [brief, turn(called("read_file", { result: "Q3 totals" }))],
      enToolUiLabels,
      "Read read_file",
    ],
    [
      "the newest turn only",
      [brief, turn(called("read_file")), turn(said("All 48 invoices match."))],
      enToolUiLabels,
      "All 48 invoices match.",
    ],
    [
      "the call's verb in Hebrew",
      [brief, turn(called("read_file"))],
      heToolUiLabels,
      "בקריאה read_file",
    ],
    ["nothing before the child writes", [brief], enToolUiLabels, undefined],
  ])("reads %s", (_case, messages, labels, line) => {
    expect(subagentLiveLine(messages, labels)).toBe(line)
  })
})
