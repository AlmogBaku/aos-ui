import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ToolUiLocaleProvider,
  enToolUiLabels,
  heToolUiLabels,
  useToolTerminalLabels,
} from "./locale"
import { Terminal } from "./terminal"
import type { AosDiff, AosTerminal } from "./tool-artifact"
import { ToolDiff } from "./tool-diff"
import { DiffTextFallback } from "./tool-diff-text"

const diffLabels = enToolUiLabels.diff
const terminalLabels = enToolUiLabels.terminal

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " const keep = 1",
  "-const oldValue = 2",
  "+const newValue = 3",
  "",
].join("\n")

const diffs: AosDiff[] = [
  {
    changes: [
      { kind: "modify", path: "src/a.ts" },
      { kind: "move", path: "src/new.ts", oldPath: "src/old.ts" },
    ],
  },
]

/** Text rendered by the element and every shadow root inside it. */
function renderedText(root: Element): string {
  let text = root.textContent ?? ""
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) text += element.shadowRoot.textContent ?? ""
  }
  return text
}

const running: AosTerminal = {
  terminalId: "term-1",
  command: "bun test",
  cwd: "/repo",
  output: "",
  running: true,
}

afterEach(() => {
  cleanup()
  vi.doUnmock("./tool-diff")
  vi.doUnmock("./terminal/terminal")
  vi.resetModules()
})

describe("ToolDiff", () => {
  it("lists every change even without a patch", () => {
    render(<ToolDiff diffs={diffs} labels={diffLabels} />)
    const list = screen.getByRole("list", { name: "Changed files" })
    const items = within(list).getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("Modified")
    expect(items[0]).toHaveTextContent("src/a.ts")
    expect(items[1]).toHaveTextContent("Moved")
    expect(items[1]).toHaveTextContent("src/old.ts")
    expect(items[1]).toHaveTextContent("src/new.ts")
  })

  it("renders the patch lines and their line counts", async () => {
    const { container } = render(
      <ToolDiff
        diffs={[{ changes: [{ kind: "modify", path: "src/a.ts" }], patch }]}
        labels={diffLabels}
      />
    )
    expect(screen.getByText("1 line added, 1 removed")).toBeInTheDocument()
    await waitFor(() =>
      expect(renderedText(container)).toContain("const newValue = 3")
    )
    expect(renderedText(container)).toContain("const oldValue = 2")
  })

  it("keeps an unparseable patch readable as text", () => {
    render(
      <ToolDiff
        diffs={[{ changes: [], patch: "not a patch" }]}
        labels={diffLabels}
      />
    )
    expect(screen.getByLabelText("Patch")).toHaveTextContent("not a patch")
  })
})

describe("diff fallback", () => {
  it("shows the changes list and the raw patch", () => {
    render(
      <DiffTextFallback diffs={[{ ...diffs[0]!, patch }]} labels={diffLabels} />
    )
    expect(
      screen.getByRole("list", { name: "Changed files" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Patch")).toHaveTextContent(
      "+const newValue = 3"
    )
  })

  it("falls back to text when the diff view cannot load", async () => {
    vi.doMock("./tool-diff", () => {
      throw new Error("chunk unavailable")
    })
    const { LazyToolDiff } = await import("./lazy-tool-views")
    render(
      <LazyToolDiff diffs={[{ ...diffs[0]!, patch }]} labels={diffLabels} />
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      diffLabels.unavailable
    )
    expect(screen.getByLabelText("Patch")).toHaveTextContent(
      "-const oldValue = 2"
    )
    expect(
      screen.getByRole("list", { name: "Changed files" })
    ).toBeInTheDocument()
  })
})

describe("Terminal", () => {
  it("shows a running command and announces only its start and end", () => {
    const { rerender } = render(
      <Terminal terminal={running} labels={terminalLabels} />
    )
    expect(screen.getByText("Running")).toBeInTheDocument()
    expect(screen.queryByText(/Exit code/)).not.toBeInTheDocument()
    expect(screen.getByText("bun test")).toBeInTheDocument()
    const live = screen.getByRole("status")
    expect(live).toHaveTextContent("Command started")

    rerender(
      <Terminal
        terminal={{ ...running, output: "\u001b[32mpass\u001b[0m 3 tests\n" }}
        labels={terminalLabels}
      />
    )
    expect(live).toHaveTextContent("Command started")
    const output = screen.getByRole("region", { name: "Terminal output" })
    expect(output).toHaveTextContent("pass 3 tests")
    expect(output.textContent).not.toContain("\u001b")

    rerender(
      <Terminal
        terminal={{
          ...running,
          output: "pass 3 tests\nfail 1 test\n",
          running: false,
          exitCode: 1,
        }}
        labels={terminalLabels}
      />
    )
    expect(screen.queryByText("Running")).not.toBeInTheDocument()
    expect(screen.getByText("Exit code 1")).toBeInTheDocument()
    expect(live).toHaveTextContent("Command ended. Exit code 1")
  })

  it("reports a signal, truncation, and an empty finished run", () => {
    const { rerender } = render(
      <Terminal
        terminal={{
          ...running,
          running: false,
          signal: "SIGTERM",
          output: "partial",
          truncated: true,
        }}
        labels={terminalLabels}
      />
    )
    expect(screen.getByText("Stopped by SIGTERM")).toBeInTheDocument()
    expect(screen.getByText("Output was truncated.")).toBeInTheDocument()

    rerender(
      <Terminal
        terminal={{ ...running, running: false, exitCode: 0 }}
        labels={terminalLabels}
      />
    )
    expect(screen.getByText("No output")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled()
  })

  it("uses the Hebrew labels from the locale layer", () => {
    function HebrewTerminal() {
      return <Terminal terminal={running} labels={useToolTerminalLabels()} />
    }
    render(
      <ToolUiLocaleProvider locale="he">
        <HebrewTerminal />
      </ToolUiLocaleProvider>
    )
    expect(
      screen.getByText(heToolUiLabels.terminal.running)
    ).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(
      heToolUiLabels.terminal.started
    )
  })

  it("falls back to plain output when the terminal view cannot load", async () => {
    vi.doMock("./terminal/terminal", () => {
      throw new Error("chunk unavailable")
    })
    const { LazyToolTerminal } = await import("./lazy-tool-views")
    render(
      <LazyToolTerminal
        terminal={{
          ...running,
          running: false,
          exitCode: 2,
          output: "\u001b[31merror\u001b[0m: missing file",
        }}
        labels={terminalLabels}
      />
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      terminalLabels.unavailable
    )
    expect(screen.getByLabelText("Terminal output")).toHaveTextContent(
      "error: missing file"
    )
    expect(screen.getByLabelText("Terminal output").textContent).not.toContain(
      "\u001b"
    )
    expect(screen.getByText("Exit code 2")).toBeInTheDocument()
  })
})
