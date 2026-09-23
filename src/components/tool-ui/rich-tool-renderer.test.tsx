import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react"

import {
  RichToolRenderer,
  AosToolPresentation,
  AosToolFallback,
  isAosRichTool,
  ToolChrome,
  ToolUiLocaleProvider,
  normalizeRichToolState,
  type RichToolPart,
} from "./index"
import { PendingInteractionProvider } from "@/components/runtime-interactions/pending-interaction-context"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import { LazyVisualBoundary } from "./lazy-boundary"
import { QuestionFlow } from "./question-flow/index"
import { SerializableQuestionFlowSchema } from "./question-flow/schema"

afterEach(cleanup)

async function renderTool(ui: Parameters<typeof render>[0]) {
  const view = render(ui)
  const waitForDisplay = () =>
    waitFor(() => {
      expect(
        view.queryByText(/^(Loading tool display…|תצוגת הכלי נטענת…)$/)
      ).not.toBeInTheDocument()
    })
  await waitForDisplay()
  return {
    ...view,
    async rerender(next: Parameters<typeof render>[0]) {
      view.rerender(next)
      await waitForDisplay()
    },
  }
}

function toolPart(
  overrides: Partial<RichToolPart> & Pick<RichToolPart, "toolName">
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
    ...overrides,
  }
}

/** A request the composer is putting to the operator beside the transcript. */
const pendingQuestionRequest: RuntimeQuestionRequest = {
  kind: "question",
  requestId: "question-1",
  sessionId: "pending",
  questions: [
    {
      header: "Choice",
      prompt: "Where do you live?",
      options: [{ label: "Tel Aviv" }, { label: "Haifa" }],
    },
  ],
}

/** A runtime that raises questions out of band and answers them elsewhere. */
function outOfBandInteractions(
  pending?: RuntimeQuestionRequest
): RuntimeInteractionAdapter {
  return {
    respond: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
    // The gate reads the mounted thread's own id, so the fake answers for it.
    getPending: () => pending,
    subscribe: () => () => {},
  }
}

/**
 * The out-of-band record reads whether the mounted thread is waiting on the
 * operator, so these cases mount the call inside a thread the gate can read.
 */
function OutOfBandThread({
  interactions,
  children,
}: {
  interactions: RuntimeInteractionAdapter
  children: ReactNode
}) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [] }) })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PendingInteractionProvider interactions={interactions}>
        {children}
      </PendingInteractionProvider>
    </AssistantRuntimeProvider>
  )
}

describe("normalizeRichToolState", () => {
  it("keeps an unresolved interactive call pending even after its message completes", () => {
    const state = normalizeRichToolState(
      toolPart({ toolName: "ask_user_question" }),
      { interactive: true }
    )

    expect(state.phase).toBe("pending")
    expect(state.canRespond).toBe(true)
  })

  it("gives provider expiry precedence over completion", () => {
    const state = normalizeRichToolState(
      toolPart({
        toolName: "request_permission",
        approval: { id: "approval-1", resolution: "expired" },
      }),
      { interactive: true }
    )

    expect(state.phase).toBe("expired")
    expect(state.canRespond).toBe(false)
  })
})

describe("rich tool classification", () => {
  it("admits only registered payloads that can render semantically", () => {
    expect(
      isAosRichTool(
        toolPart({
          toolName: "ask_user_question",
          args: { question: "Proceed?", options: ["Yes", "No"] },
        })
      )
    ).toBe(true)
    expect(
      isAosRichTool(
        toolPart({ toolName: "ask_user_question", args: { question: 5 } })
      )
    ).toBe(false)
  })

  it("renders a provider-neutral question but leaves OpenCode's batched question to its bridge", () => {
    expect(
      isAosRichTool(
        toolPart({
          toolName: "question",
          args: { question: "Proceed?", options: ["Yes", "No"] },
        })
      )
    ).toBe(true)
    expect(
      isAosRichTool(
        toolPart({
          toolName: "question",
          args: {
            questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
          },
        })
      )
    ).toBe(false)
  })
})

describe("AosToolFallback", () => {
  it.each([
    ["an unknown call", "unknown_tool", { type: "complete" }],
    [
      "an interrupted question",
      "question",
      { type: "incomplete", reason: "cancelled" },
    ],
  ] as const)(
    "keeps %s collapsed until its paired request and result are requested",
    async (_description, toolName, status) => {
      const user = userEvent.setup()
      const { container } = render(
        <AosToolFallback
          {...toolPart({
            toolName,
            status,
            args: { question: "Continue?", token: "secret=never-show" },
            result: "Provider result",
          })}
        />
      )

      expect(
        container.querySelector('[data-slot="generic-tool"]')
      ).not.toBeInTheDocument()
      const trigger = screen.getByRole("button")
      expect(trigger).toHaveAttribute("aria-expanded", "false")
      expect(within(trigger).getByText("Used")).toBeVisible()
      expect(within(trigger).getByText(toolName)).toBeVisible()
      expect(screen.queryByText("[REDACTED]", { exact: false })).toBeNull()
      expect(screen.queryByText(/Provider result/)).toBeNull()
      expect(container.querySelector("[data-tool-state]")).toHaveAttribute(
        "data-tool-state",
        status.type === "complete"
          ? "complete"
          : status.reason === "cancelled"
            ? "cancelled"
            : "failed"
      )

      await user.click(trigger)
      expect(trigger).toHaveAttribute("aria-expanded", "true")
      expect(screen.getAllByText(/Continue?/).at(-1)).toBeVisible()
      expect(screen.getByText("[REDACTED]", { exact: false })).toBeVisible()
      expect(screen.getByText(/Provider result/)).toBeVisible()
    }
  )

  it("keeps a failed command in its terminal with its exit status and hint", async () => {
    const user = userEvent.setup()
    const hint = "Exit 124: the command hit its timeout. Raise timeout=."
    render(
      <AosToolPresentation
        {...toolPart({
          toolName: "terminal",
          args: { command: "sleep 5" },
          result: {
            output: "[Command timed out after 2s]",
            exit_code: 124,
            error: null,
            hint,
          },
        })}
      />
    )

    const trigger = screen.getByRole("button")
    expect(within(trigger).getByText("sleep 5")).toBeVisible()
    expect(screen.queryByText("1/1")).not.toBeInTheDocument()

    await user.click(trigger)
    expect(screen.getByText("[Command timed out after 2s]")).toBeVisible()
    expect(screen.getByText("exit 124")).toBeVisible()
    expect(screen.getByText(hint)).toBeVisible()
  })

  it("keeps a stopped command's output lines as written", async () => {
    const user = userEvent.setup()
    render(
      <AosToolPresentation
        {...toolPart({
          toolName: "terminal",
          args: { command: "sleep 30" },
          result: { output: "waiting\n[Command interrupted]", exit_code: 130 },
        })}
      />
    )

    await user.click(screen.getByRole("button"))
    expect(screen.getByText("waiting")).toBeVisible()
    expect(screen.getByText("[Command interrupted]")).toBeVisible()
    expect(screen.getByText("exit 130")).toBeVisible()
  })

  it("shows a hint only when the command failed", async () => {
    const user = userEvent.setup()
    render(
      <AosToolFallback
        {...toolPart({
          toolName: "terminal",
          args: { command: "bun run dev", background: true },
          result: {
            output: "Background process started",
            exit_code: 0,
            hint: "Started silently.",
          },
        })}
      />
    )

    await user.click(screen.getByRole("button"))
    expect(screen.getByText("exit 0")).toBeVisible()
    expect(screen.queryByText("Started silently.")).not.toBeInTheDocument()
  })

  it("names a running command before any output arrives", async () => {
    const user = userEvent.setup()
    render(
      <AosToolFallback
        {...toolPart({
          toolName: "terminal",
          args: { command: "for i in 1 2 3; do echo $i; sleep 1; done" },
          status: { type: "running" },
        })}
      />
    )

    const trigger = screen.getByRole("button")
    expect(
      within(trigger).getByText("for i in 1 2 3; do echo $i; sleep 1; done")
    ).toBeVisible()
    expect(within(trigger).queryByText("terminal")).not.toBeInTheDocument()
    await user.click(trigger)
    expect(screen.queryByText(/^exit /)).not.toBeInTheDocument()
  })

  it("uses Tool Error for a failed call that runs no command", () => {
    render(
      <AosToolPresentation
        {...toolPart({
          toolName: "fetch_page",
          args: { url: "https://example.com" },
          result: { error: "Not found\nstatus 404" },
          isError: true,
        })}
      />
    )

    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === "Not found\nstatus 404" &&
          element.children.length === 0
      )
    ).toBeVisible()
  })

  it.each([
    { name: "stopped", exitCode: 130, output: "[Command interrupted]" },
    { name: "finished", exitCode: 0, output: "Built successfully" },
  ])(
    "lays a $name command and its output out left to right in Hebrew",
    async ({ exitCode, output }) => {
      const user = userEvent.setup()
      render(
        <ToolUiLocaleProvider locale="he">
          <AosToolFallback
            {...toolPart({
              toolName: "terminal",
              args: { command: "bun run build --filter web" },
              result: { output, exit_code: exitCode },
            })}
          />
        </ToolUiLocaleProvider>
      )

      const trigger = screen.queryByRole("button")
      if (trigger) await user.click(trigger)
      for (const text of ["bun run build --filter web", output]) {
        for (const element of screen.getAllByText(text))
          expect(element.closest("[dir]")).toHaveAttribute("dir", "ltr")
      }
    }
  )

  it("uses Terminal Block for command output", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <AosToolFallback
        {...toolPart({
          toolName: "terminal",
          args: { command: "bun run build" },
          result: { output: "Built successfully", exit_code: 0 },
        })}
      />
    )

    await user.click(screen.getByRole("button"))
    expect(
      container.querySelector('[data-slot="terminal-block"]')
    ).toBeVisible()
    expect(screen.getByText("Built successfully")).toBeVisible()
  })

  it("uses Code Runner for any tool call carrying code and a language", async () => {
    const user = userEvent.setup()
    render(
      <AosToolFallback
        {...toolPart({
          toolName: "run_snippet",
          args: { code: "print(42)", language: "python" },
          result: {
            status: "success",
            output: "42",
            exit_code: 0,
            duration_seconds: 0.02,
          },
        })}
      />
    )

    const trigger = screen.getByRole("button")
    expect(within(trigger).getByText("run_snippet")).toBeVisible()
    expect(screen.queryByText("print(42)")).not.toBeInTheDocument()

    await user.click(trigger)

    expect(screen.getByText("python")).toBeVisible()
    expect(screen.getByText("print(42)")).toBeVisible()
    expect(screen.getByText("42")).toBeVisible()
    expect(
      screen.getByRole("button", { name: "Run this snippet" })
    ).toBeDisabled()
  })

  it("shows code without a language label when the call declares none", async () => {
    const user = userEvent.setup()
    render(
      <AosToolFallback
        {...toolPart({
          toolName: "run_snippet",
          args: { code: "print(42)" },
          result: { status: "success", output: "42", exit_code: 0 },
        })}
      />
    )

    await user.click(screen.getByRole("button"))

    expect(screen.getByText("print(42)")).toBeVisible()
    expect(screen.getByText("42")).toBeVisible()
    expect(
      screen.getByRole("button", { name: "Run this snippet" })
    ).toBeDisabled()
    expect(screen.queryByText("python")).not.toBeInTheDocument()
  })
})

describe("accessible rich-tool semantics", () => {
  const completeState = {
    phase: "complete",
    label: "Complete",
    canRespond: false,
  } as const

  it("renders a standalone ToolChrome title at heading level 2", () => {
    render(<ToolChrome title="Standalone tool" state={completeState} />)

    expect(
      screen.getByRole("heading", { name: "Standalone tool", level: 2 })
    ).toBeVisible()
  })

  it("renders explicitly nested rich-tool titles at heading level 3", () => {
    render(
      <>
        <ToolChrome
          title="Nested tool"
          state={completeState}
          headingLevel={3}
        />
        <QuestionFlow
          id="nested-question"
          step={1}
          title="Nested question"
          options={[{ id: "answer", label: "Answer" }]}
          headingLevel={3}
        />
      </>
    )

    for (const name of ["Nested tool", "Nested question"]) {
      expect(screen.getByRole("heading", { name, level: 3 })).toBeVisible()
    }
  })

  it("renders a QuestionFlow receipt title at its requested heading level", () => {
    render(
      <QuestionFlow
        id="nested-receipt"
        choice={{
          title: "Recorded answer",
          summary: [{ label: "Audience", value: "Team" }],
        }}
        headingLevel={3}
      />
    )

    expect(
      screen.getByRole("heading", { name: "Recorded answer", level: 3 })
    ).toBeVisible()
  })

  it("renders a QuestionFlow nested under ToolChrome one level below its tool title", async () => {
    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "ask_user_question",
          args: {
            question: "Choose a market",
            options: ["Israel", "United Kingdom"],
          },
          status: { type: "requires-action", reason: "tool-calls" },
        })}
      />
    )

    const chrome = document.querySelector<HTMLElement>(
      '[data-slot="tool-chrome"]'
    )
    const questionFlow = document.querySelector<HTMLElement>(
      '[data-slot="question-flow"]'
    )

    expect(chrome).not.toBeNull()
    expect(questionFlow).not.toBeNull()
    expect(
      within(chrome!).getByRole("heading", {
        name: "Choose a market",
        level: 2,
      })
    ).toBeVisible()
    expect(
      within(questionFlow!).getByRole("heading", {
        name: "Choose a market",
        level: 3,
      })
    ).toBeVisible()
  })

  it.each([
    ["en", "Question progress"],
    ["he", "התקדמות השאלה"],
  ] as const)(
    "gives the QuestionFlow progressbar its localized %s accessible name",
    (locale, accessibleName) => {
      render(
        <ToolUiLocaleProvider locale={locale}>
          <QuestionFlow
            id={`question-${locale}`}
            steps={[
              {
                id: "audience",
                title: "Audience",
                options: [{ id: "team", label: "Team" }],
              },
              {
                id: "format",
                title: "Format",
                options: [{ id: "brief", label: "Brief" }],
              },
            ]}
          />
        </ToolUiLocaleProvider>
      )

      expect(
        screen.getByRole("progressbar", { name: accessibleName })
      ).toHaveAttribute("aria-valuenow", "1")
    }
  )

  it("keeps headingLevel out of the serializable QuestionFlow payload", () => {
    const question = SerializableQuestionFlowSchema.parse({
      id: "question-schema",
      step: 1,
      title: "Question schema",
      options: [{ id: "option", label: "Option" }],
      headingLevel: 3,
    })

    expect(question).not.toHaveProperty("headingLevel")
  })
})

describe("QuestionFlow renderer", () => {
  it("leaves OpenCode's native batched question call to the composer bridge", async () => {
    const { container } = await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "question",
          args: {
            questions: [
              {
                header: "Scope",
                question: "Which boundary should the Agent use?",
                options: [
                  {
                    label: "Focused",
                    description: "Keep the Agent narrowly scoped",
                  },
                ],
              },
            ],
          },
          status: { type: "running" },
        })}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ["missing options", { question: "Unanswerable question" }],
    [
      "an empty options list",
      { question: "Unanswerable question", options: [] },
    ],
    [
      "an explicitly disabled freeform answer",
      {
        question: "Unanswerable question",
        options: [],
        allowFreeform: false,
      },
    ],
  ])("uses the malformed fallback for %s", async (_case, args) => {
    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "ask_user_question",
          args,
          status: { type: "requires-action", reason: "tool-calls" },
        })}
      />
    )

    expect(
      screen.getByText("Could not safely render Question")
    ).toBeInTheDocument()
    expect(screen.queryByRole("option")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("uses the registry QuestionFlow slot and submits its selected provider option", async () => {
    const user = userEvent.setup()
    const addResult = vi.fn()

    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "ask_user_question",
          args: {
            question: "Choose a market",
            options: ["Israel", "United Kingdom"],
          },
          status: { type: "requires-action", reason: "tool-calls" },
          addResult,
        })}
      />
    )

    expect(screen.getByRole("option", { name: "Israel" })).toBeVisible()
    await user.click(screen.getByRole("option", { name: "Israel" }))
    await user.click(screen.getByRole("button", { name: "Submit answer" }))

    expect(addResult).toHaveBeenCalledTimes(1)
    expect(addResult).toHaveBeenCalledWith({ answer: "Israel" })
  })

  it("uses the registry OptionList slot for hybrid option and free-text questions", async () => {
    const user = userEvent.setup()
    const addResult = vi.fn()

    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "ask_user_question",
          args: {
            question: "Choose or explain",
            options: ["Use the option"],
            allowFreeform: true,
          },
          status: { type: "requires-action", reason: "tool-calls" },
          addResult,
        })}
      />
    )

    expect(screen.getByRole("option", { name: "Use the option" })).toBeVisible()
    await user.click(screen.getByRole("option", { name: "Use the option" }))

    expect(addResult).toHaveBeenCalledTimes(1)
    expect(addResult).toHaveBeenCalledWith({ answer: "Use the option" })
  })

  it("submits a free-text answer through the tool result seam", async () => {
    const user = userEvent.setup()
    const addResult = vi.fn()

    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "ask_user_question",
          args: {
            question: "Which audience should the brief prioritize?",
            allowFreeform: true,
          },
          status: { type: "requires-action", reason: "tool-calls" },
          addResult,
        })}
      />
    )

    await user.type(
      screen.getByRole("textbox", { name: "Your answer" }),
      "Design leads"
    )
    await user.click(screen.getByRole("button", { name: "Submit answer" }))

    expect(addResult).toHaveBeenCalledWith({ answer: "Design leads" })
    expect(screen.getByText("Answered")).toBeInTheDocument()
    expect(screen.getByText("Design leads")).toBeInTheDocument()
  })

  it("shows submitting, answered, failed, and expired as distinct states", async () => {
    let resolveApproval: (() => void) | undefined
    const respondToApproval = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveApproval = resolve
        })
    )
    const base = toolPart({
      toolName: "ask_user_question",
      args: { question: "Name the audience", allowFreeform: true },
      approval: {
        id: "question-1",
        prompt: "Name the audience",
        display: "text",
        allowFreeform: true,
      },
      status: { type: "requires-action", reason: "tool-calls" },
      respondToApproval,
    })
    const { rerender } = await renderTool(<RichToolRenderer {...base} />)

    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), {
      target: { value: "Product team" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }))
    expect(screen.getByText("Submitting")).toBeInTheDocument()

    await act(async () => resolveApproval?.())
    expect(screen.getByText("Answered")).toBeInTheDocument()

    await rerender(
      <RichToolRenderer
        {...base}
        approval={{ ...base.approval!, resolution: "expired" }}
      />
    )
    expect(screen.getByText("Expired")).toBeInTheDocument()

    await rerender(
      <RichToolRenderer
        {...base}
        approval={undefined}
        isError
        status={{
          type: "incomplete",
          reason: "error",
          error: "Provider failed",
        }}
      />
    )
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  it("offers a localized retry after failure and guards it from double-submit", async () => {
    const user = userEvent.setup()
    let resolveRetry: (() => void) | undefined
    const retryResult = new Promise<void>((resolve) => {
      resolveRetry = resolve
    })
    const addResult = vi
      .fn()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockImplementation(() => retryResult)

    await renderTool(
      <ToolUiLocaleProvider locale="he">
        <RichToolRenderer
          {...toolPart({
            toolName: "ask_user_question",
            args: { question: "Retry this answer?", allowFreeform: true },
            status: { type: "requires-action", reason: "tool-calls" },
            addResult,
          })}
        />
      </ToolUiLocaleProvider>
    )

    await user.type(
      screen.getByRole("textbox", { name: "התשובה שלך" }),
      "Provider answer"
    )
    await user.click(screen.getByRole("button", { name: "שליחת תשובה" }))
    const retry = await screen.findByRole("button", { name: "ניסיון חוזר" })

    fireEvent.click(retry)
    fireEvent.click(retry)

    expect(addResult).toHaveBeenCalledTimes(2)
    expect(addResult).toHaveBeenLastCalledWith({ answer: "Provider answer" })
    expect(screen.queryByRole("button", { name: "ניסיון חוזר" })).toBeNull()

    await act(async () => resolveRetry?.())
    expect(screen.getByText("נענה")).toBeInTheDocument()
  })

  it("keeps a batched question read-only when no out-of-band request is pending", async () => {
    await renderTool(
      <OutOfBandThread interactions={outOfBandInteractions()}>
        <RichToolRenderer
          {...toolPart({
            toolName: "question",
            args: {
              question: "3 questions",
              questions: [
                {
                  question: "Where do you live?",
                  options: ["Tel Aviv", "Haifa"],
                },
                { question: "Which amenities do you use?", multiple: true },
                { question: "When should I follow up?", allowFreeform: true },
              ],
              allowFreeform: true,
            },
            status: { type: "requires-action", reason: "tool-calls" },
          })}
        />
      </OutOfBandThread>
    )

    expect(screen.getByText("Needs response")).toBeVisible()
    for (const asked of [
      "Where do you live?",
      "Which amenities do you use?",
      "When should I follow up?",
      "Tel Aviv",
      "Haifa",
    ]) {
      expect(screen.getByText(asked)).toBeVisible()
    }
    expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull()
    expect(screen.queryAllByRole("option")).toEqual([])
  })

  it("reads a cancelled out-of-band result as unanswered rather than an answer form", async () => {
    await renderTool(
      <OutOfBandThread
        interactions={outOfBandInteractions(pendingQuestionRequest)}
      >
        <RichToolRenderer
          {...toolPart({
            toolName: "question",
            args: {
              question: "2 questions",
              questions: [
                { question: "Where do you live?", allowFreeform: true },
                {
                  question: "Which amenities do you use?",
                  allowFreeform: true,
                },
              ],
              allowFreeform: true,
            },
            result: {
              status: "cancelled",
              responses: [
                { question: "Where do you live?", answers: [] },
                { question: "Which amenities do you use?", answers: [] },
              ],
            },
            status: { type: "complete" },
          })}
        />
      </OutOfBandThread>
    )

    expect(screen.getByText("Cancelled")).toBeVisible()
    expect(screen.getByText("Where do you live?")).toBeVisible()
    expect(screen.getAllByText("Discarded")).toHaveLength(2)
    expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull()
  })

  it("leaves the composer the only place a pending question is asked", async () => {
    await renderTool(
      <OutOfBandThread
        interactions={outOfBandInteractions(pendingQuestionRequest)}
      >
        <RichToolRenderer
          {...toolPart({
            toolName: "question",
            args: {
              question: "2 questions",
              questions: [
                {
                  question: "Where do you live?",
                  options: ["Tel Aviv", "Haifa"],
                },
                { question: "When should I follow up?", allowFreeform: true },
              ],
              allowFreeform: true,
            },
            status: { type: "requires-action", reason: "tool-calls" },
          })}
        />
      </OutOfBandThread>
    )

    for (const asked of [
      "2 questions",
      "Where do you live?",
      "When should I follow up?",
      "Tel Aviv",
      "Haifa",
      "Needs response",
    ]) {
      expect(screen.queryByText(asked)).toBeNull()
    }
  })

  it("records the answers once the operator responds beside the composer", async () => {
    await renderTool(
      <OutOfBandThread
        interactions={outOfBandInteractions(pendingQuestionRequest)}
      >
        <RichToolRenderer
          {...toolPart({
            toolName: "question",
            args: {
              question: "2 questions",
              questions: [
                {
                  question: "Where do you live?",
                  options: ["Tel Aviv", "Haifa"],
                },
                { question: "When should I follow up?", allowFreeform: true },
              ],
              allowFreeform: true,
            },
            result: {
              responses: [
                { question: "Where do you live?", answers: ["Ramat Gan"] },
                {
                  question: "When should I follow up?",
                  answers: ["Next week"],
                },
              ],
            },
            status: { type: "complete" },
          })}
        />
      </OutOfBandThread>
    )

    expect(screen.getByText("Answered")).toBeVisible()
    for (const shown of [
      "Where do you live?",
      "When should I follow up?",
      "Ramat Gan",
      "Next week",
    ]) {
      expect(screen.getByText(shown)).toBeVisible()
    }
    expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull()
  })
  /** The three questions one batched clarify call put to the operator. */
  const batched = {
    question: "3 questions",
    questions: [
      {
        question: "What should we prioritize this week?",
        options: ["Pipeline / revenue", "Content / operator brand"],
      },
      {
        question: "Which areas do you want included?",
        options: ["Pipeline", "Content"],
        multiple: true,
      },
      {
        question: "What is the one outcome that would make this week a win?",
        allowFreeform: true,
      },
    ],
    allowFreeform: true,
  }

  /** What the provider recorded when it settled two of those three. */
  const twoOfThree = {
    status: "answered",
    responses: [
      {
        question: "What should we prioritize this week?",
        answers: ["Content / operator brand"],
      },
      {
        question: "What is the one outcome that would make this week a win?",
        answers: [],
      },
    ],
  }

  /** The read-only record those questions leave, under one provider result. */
  const renderQuestionRecord = (result: RichToolPart["result"]) =>
    renderTool(
      <OutOfBandThread interactions={outOfBandInteractions()}>
        <RichToolRenderer
          {...toolPart({
            toolName: "question",
            args: batched,
            result,
            status: { type: "complete" },
          })}
        />
      </OutOfBandThread>
    )

  /** The one record row an asked question reads on, its answer included. */
  const askedRow = (question: string) => {
    const row = screen.getByText(question).closest("li")
    if (!row) throw new Error(`No record row for "${question}"`)
    return row
  }

  it("keeps a multi-select answer with the question it answers", async () => {
    await renderQuestionRecord({
      status: "answered",
      responses: [
        {
          question: "Which areas do you want included?",
          answers: ["Pipeline", "Content"],
        },
      ],
    })

    expect(askedRow("Which areas do you want included?")).toHaveTextContent(
      "Response: Pipeline, Content"
    )
    expect(
      askedRow("What should we prioritize this week?")
    ).not.toHaveTextContent("Response:")
  })

  it("leaves a question the provider recorded nothing for without a response", async () => {
    await renderQuestionRecord(twoOfThree)

    expect(askedRow("Which areas do you want included?")).not.toHaveTextContent(
      "Response:"
    )
  })

  it("reads a question the operator answered with nothing as discarded", async () => {
    await renderQuestionRecord(twoOfThree)

    expect(
      askedRow("What is the one outcome that would make this week a win?")
    ).toHaveTextContent("Response: Discarded")
  })
})

describe("provider permission renderer", () => {
  it("renders approvals attached to provider-native tool names", async () => {
    const user = userEvent.setup()
    const respondToApproval = vi.fn().mockResolvedValue(undefined)

    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "bash",
          args: { command: "pwd" },
          status: { type: "requires-action", reason: "tool-calls" },
          approval: {
            id: "opencode-bash-approval",
            prompt: "Allow this command?",
            options: [
              { id: "once", kind: "allow-once", label: "Allow once" },
              { id: "reject", kind: "reject-once", label: "Reject" },
            ],
          },
          respondToApproval,
        })}
      />
    )

    expect(screen.getByText("Allow this command?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Allow once" }))
    expect(respondToApproval).toHaveBeenCalledWith({ optionId: "once" })
  })

  it("only offers persistent permission when its provider scope is visible", async () => {
    const user = userEvent.setup()
    const respondToApproval = vi.fn().mockResolvedValue(undefined)

    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "request_permission",
          args: { action: "Read the shared market dataset" },
          status: { type: "requires-action", reason: "tool-calls" },
          approval: {
            id: "permission-1",
            prompt: "Allow Aster to read the shared market dataset?",
            options: [
              { id: "once", kind: "allow-once", label: "Allow once" },
              {
                id: "always-dataset",
                kind: "allow-always",
                label: "Always for this dataset",
                grants: ["datasets/market/**"],
              },
              {
                id: "always-hidden",
                kind: "allow-always",
                label: "Always everywhere",
              },
              { id: "reject", kind: "reject-once", label: "Reject" },
            ],
          },
          respondToApproval,
        })}
      />
    )

    expect(screen.getByText("datasets/market/**")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Always everywhere" })
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Always for this dataset" })
    )
    expect(screen.getByText("Keep this permission?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Confirm always" }))

    await waitFor(() =>
      expect(respondToApproval).toHaveBeenCalledWith({
        optionId: "always-dataset",
      })
    )
  })

  it("does not invent choices when the provider supplies no option ids", async () => {
    const respondToApproval = vi.fn()
    const part = toolPart({
      toolName: "request_permission",
      args: { action: "Read provider data" },
      status: { type: "requires-action", reason: "tool-calls" },
      approval: {
        id: "permission-without-options",
        prompt: "Provider supplied no answerable choices",
        options: [
          { kind: "allow-once", label: "Choice without an id" },
        ] as unknown as NonNullable<RichToolPart["approval"]>["options"],
      },
      respondToApproval,
    })
    const { rerender } = await renderTool(<RichToolRenderer {...part} />)

    expect(screen.getByText("Unavailable")).toBeInTheDocument()
    expect(
      screen.getByText("The provider did not supply an answerable choice.")
    ).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
    expect(respondToApproval).not.toHaveBeenCalled()

    await rerender(
      <RichToolRenderer
        {...part}
        approval={{ ...part.approval!, resolution: "expired" }}
      />
    )
    expect(screen.getByText("Expired")).toBeInTheDocument()
    expect(screen.queryByText("Unavailable")).toBeNull()
  })

  it("renders every settled Hermes question with its recorded answer or discard", async () => {
    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "question",
          args: {
            question: "2 questions",
            questions: [
              { question: "Where do you live?" },
              { question: "Which amenities do you use?" },
            ],
            allowFreeform: true,
          },
          result: {
            status: "cancelled",
            responses: [
              { question: "Where do you live?", answers: [] },
              { question: "Which amenities do you use?", answers: [] },
            ],
          },
          status: { type: "complete" },
        })}
      />
    )

    expect(screen.getByText("Where do you live?")).toBeVisible()
    expect(screen.getByText("Which amenities do you use?")).toBeVisible()
    expect(screen.getAllByText("Discarded")).toHaveLength(2)
  })

  it("retries the same provider-native choice once without double-submit", async () => {
    const user = userEvent.setup()
    let resolveRetry: (() => void) | undefined
    const retryResult = new Promise<void>((resolve) => {
      resolveRetry = resolve
    })
    const respondToApproval = vi
      .fn()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockImplementation(() => retryResult)

    await renderTool(
      <ToolUiLocaleProvider locale="he">
        <RichToolRenderer
          {...toolPart({
            toolName: "request_permission",
            args: { action: "Read provider data" },
            status: { type: "requires-action", reason: "tool-calls" },
            approval: {
              id: "permission-retry",
              prompt: "Retry provider permission",
              options: [
                {
                  id: "provider-once",
                  kind: "allow-once",
                  label: "Provider allow once",
                },
              ],
            },
            respondToApproval,
          })}
        />
      </ToolUiLocaleProvider>
    )

    await user.click(
      screen.getByRole("button", { name: "Provider allow once" })
    )
    const retry = await screen.findByRole("button", { name: "ניסיון חוזר" })

    fireEvent.click(retry)
    fireEvent.click(retry)

    expect(respondToApproval).toHaveBeenCalledTimes(2)
    expect(respondToApproval).toHaveBeenLastCalledWith({
      optionId: "provider-once",
    })

    await act(async () => resolveRetry?.())
    expect(screen.getByText("נענה")).toBeInTheDocument()
  })
})

describe("informational renderers", () => {
  it("keeps subagent activity visible as message content", async () => {
    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "delegate_subagent",
          args: { task: "Validate the market segments" },
          result: {
            name: "Data analyst",
            status: "completed",
            summary: "Validated three segments.",
          },
        })}
      />
    )

    expect(screen.getByText("Validated three segments.")).toBeVisible()
    expect(screen.queryByText("Transcript")).toBeNull()
    expect(screen.queryByText("Transcript unavailable.")).toBeNull()
  })

  it.each([
    ["running", "Running", "Transcript is loading…"],
    ["waiting", "Waiting", "Transcript is loading…"],
  ] as const)(
    "shows validated child status %s and its transcript state",
    async (status, statusLabel, transcriptLabel) => {
      await renderTool(
        <RichToolRenderer
          {...toolPart({
            toolName: "delegate_subagent",
            args: { task: "Inspect child state" },
            result: { name: "Child agent", status },
          })}
        />
      )

      expect(screen.getByText(statusLabel)).toBeInTheDocument()
      expect(screen.getByText(transcriptLabel)).toBeInTheDocument()
      expect(screen.queryByRole("button")).toBeNull()
    }
  )

  it.each([
    ["completed", "Completed"],
    ["failed", "Failed"],
  ] as const)(
    "omits a fake transcript section when child status is %s and none was supplied",
    async (status, statusLabel) => {
      await renderTool(
        <RichToolRenderer
          {...toolPart({
            toolName: "delegate_subagent",
            args: { task: "Inspect child state" },
            result: { name: "Child agent", status },
          })}
        />
      )

      expect(screen.getByText(statusLabel)).toBeInTheDocument()
      expect(screen.queryByText("Transcript")).toBeNull()
      expect(screen.queryByText("Transcript unavailable.")).toBeNull()
    }
  )

  it("renders a supplied transcript verbatim and rejects unknown child status", async () => {
    const { rerender } = await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "delegate_subagent",
          args: { task: "Inspect transcript" },
          result: {
            name: "Child agent",
            status: "completed",
            transcript: "Provider transcript",
          },
        })}
      />
    )

    expect(screen.getByText("Provider transcript")).toHaveAttribute(
      "dir",
      "auto"
    )
    expect(screen.queryByText("Transcript unavailable.")).toBeNull()

    await rerender(
      <RichToolRenderer
        {...toolPart({
          toolName: "delegate_subagent",
          args: { task: "Inspect invalid status" },
          result: { name: "Child agent", status: "mystery" },
        })}
      />
    )
    expect(
      screen.getByText("Could not safely render Subagent activity")
    ).toBeInTheDocument()
  })
})

describe("safe result renderers", () => {
  it("announces a visual chunk failure while preserving the surrounding data UI", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    function BrokenVisual(): never {
      throw new Error("visual chunk failed")
    }

    render(
      <>
        <LazyVisualBoundary fallbackLabel="Visual unavailable. Data remains available.">
          <BrokenVisual />
        </LazyVisualBoundary>
        <p>Textual data</p>
      </>
    )

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Visual unavailable. Data remains available."
    )
    expect(screen.getByText("Textual data")).toBeInTheDocument()
  })

  it("uses the inspectable JSON fallback for unknown and malformed known tools", async () => {
    const user = userEvent.setup()
    const { rerender } = await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "unknown_fixture_tool",
          args: { unexpected: [null, 42] },
          result: "not-an-object",
        })}
      />
    )

    expect(screen.getByText("unknown_fixture_tool")).toBeInTheDocument()
    await user.click(screen.getByText("unknown_fixture_tool"))
    expect(screen.getByText(/"unexpected"/)).toBeInTheDocument()
    expect(screen.getByText(/not-an-object/)).toBeInTheDocument()

    await rerender(
      <RichToolRenderer
        {...toolPart({
          toolName: "ask_user_question",
          args: { question: 5 },
        })}
      />
    )
    expect(
      screen.getByText("Could not safely render Question")
    ).toBeInTheDocument()
  })

  it("renders a described subagent delegation as visible activity", async () => {
    await renderTool(
      <RichToolRenderer
        {...toolPart({
          toolName: "delegate_subagent",
          args: { description: "Review the launch plan" },
          result: { summary: "The review is complete." },
        })}
      />
    )

    expect(screen.getByText("Review the launch plan")).toBeInTheDocument()
    expect(screen.getByText("The review is complete.")).toBeInTheDocument()
  })

})

describe("Hebrew tool UI", () => {
  it("localizes QuestionFlow chrome while preserving payload text and direction", async () => {
    await renderTool(
      <ToolUiLocaleProvider locale="he">
        <RichToolRenderer
          {...toolPart({
            toolName: "ask_user_question",
            args: {
              question: "Keep this provider question verbatim?",
              options: ["Payload option"],
              allowFreeform: true,
            },
            status: { type: "requires-action", reason: "tool-calls" },
          })}
        />
      </ToolUiLocaleProvider>
    )

    expect(screen.getByText("נדרשת תשובה")).toBeInTheDocument()
    expect(
      screen.getByRole("group", { name: "אפשרויות תשובה" })
    ).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "התשובה שלך" })).toHaveAttribute(
      "dir",
      "auto"
    )
    expect(
      screen.getByRole("button", { name: "שליחת תשובה" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("heading", {
        name: "Keep this provider question verbatim?",
      })
    ).toHaveAttribute("dir", "auto")
    expect(
      screen.getByRole("option", { name: "Payload option" })
    ).toHaveAttribute("dir", "auto")
  })

  it("localizes permission defaults and keeps provider scope identifiers LTR", async () => {
    await renderTool(
      <ToolUiLocaleProvider locale="he">
        <RichToolRenderer
          {...toolPart({
            toolName: "request_permission",
            args: { action: "Read the provider dataset" },
            status: { type: "requires-action", reason: "tool-calls" },
            approval: {
              id: "permission-he",
              prompt: "Allow this provider operation verbatim?",
              options: [
                {
                  id: "always-dataset",
                  kind: "allow-always",
                  grants: ["datasets/market/**"],
                },
              ],
            },
          })}
        />
      </ToolUiLocaleProvider>
    )

    expect(screen.getByRole("heading", { name: "בקשת הרשאה" })).toBeVisible()
    expect(
      screen.getByText("Allow this provider operation verbatim?")
    ).toHaveAttribute("dir", "auto")
    expect(
      screen.getByRole("button", { name: "אישור קבוע" })
    ).toBeInTheDocument()
    expect(screen.getByText("datasets/market/**")).toHaveAttribute("dir", "ltr")
  })

  it("localizes malformed fallback and copy feedback", async () => {
    const user = userEvent.setup()
    await renderTool(
      <ToolUiLocaleProvider locale="he">
        <RichToolRenderer
          {...toolPart({
            toolName: "ask_user_question",
            args: { question: 5 },
          })}
        />
      </ToolUiLocaleProvider>
    )

    expect(screen.getByText("לא ניתן להציג בבטחה: שאלה")).toBeInTheDocument()
    await user.click(screen.getByText("לא ניתן להציג בבטחה: שאלה"))
    expect(screen.getByRole("button", { name: "העתקת JSON" })).toBeVisible()

    await user.click(screen.getByRole("button", { name: "העתקת JSON" }))
    expect(screen.getByRole("button", { name: "הועתק" })).toBeVisible()
  })

  it("localizes visible activity chrome", async () => {
    await renderTool(
      <ToolUiLocaleProvider locale="he">
        <RichToolRenderer
          {...toolPart({
            toolName: "delegate_subagent",
            args: { task: "Provider task" },
            result: {
              name: "Provider agent",
              status: "waiting",
              summary: "Provider summary",
            },
          })}
        />
      </ToolUiLocaleProvider>
    )

    expect(screen.getByText("סוכן משנה")).toBeInTheDocument()
    expect(screen.getByText("בהמתנה")).toBeInTheDocument()
    expect(screen.getByText("התמליל נטען…")).toBeInTheDocument()
    expect(screen.getByText("Provider agent")).toHaveAttribute("dir", "auto")
    expect(screen.getByText("Provider summary")).toHaveAttribute("dir", "auto")
  })

})
