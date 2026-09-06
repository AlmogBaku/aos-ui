import type {
  OpenCodeQuestionRequest,
  OpenCodeThreadState,
  OpencodeClient,
} from "@assistant-ui/react-opencode"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PropsWithChildren } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  replyToQuestion,
  rejectQuestion,
  useOpenCodeQuestions,
  useOpenCodeRuntimeExtras,
  useOpenCodeSession,
  openCodeEventListeners,
} = vi.hoisted(() => ({
  replyToQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
  useOpenCodeQuestions: vi.fn(),
  useOpenCodeRuntimeExtras: vi.fn(),
  useOpenCodeSession: vi.fn(),
  openCodeEventListeners: new Set<
    (event: {
      type: string
      sessionId?: string
      properties: Record<string, unknown>
    }) => void
  >(),
}))

vi.mock("@assistant-ui/react-opencode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react-opencode")>()),
  OpenCodeEventSource: class {
    subscribe(
      listener: (event: {
        type: string
        sessionId?: string
        properties: Record<string, unknown>
      }) => void
    ) {
      openCodeEventListeners.add(listener)
      return () => openCodeEventListeners.delete(listener)
    }

    dispose() {}
  },
  useOpenCodeQuestions,
  useOpenCodeRuntimeExtras,
  useOpenCodeSession,
}))

vi.mock("@assistant-ui/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react")>()),
  AssistantRuntimeProvider: ({ children }: PropsWithChildren) => children,
}))

import { OpenCodeQuestionBridge } from "./aos-ui-opencode-app"

const request = {
  id: "question-1",
  sessionID: "session-build",
  askedAt: 1,
  questions: [
    {
      header: "Approach",
      question: "How should I proceed?",
      options: [
        { label: "Fast", description: "Make the smallest safe change" },
        { label: "Thorough", description: "Check every integration" },
      ],
      custom: true,
    },
  ],
} satisfies OpenCodeQuestionRequest

function createClient(listed: OpenCodeQuestionRequest[] = []) {
  return {
    question: {
      list: vi.fn(async () => ({ data: listed })),
    },
  } as unknown as OpencodeClient
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function orphanedQuestionState(
  questions: OpenCodeQuestionRequest["questions"] = request.questions
): OpenCodeThreadState {
  return {
    sessionId: "session-build",
    session: null,
    sessionStatus: { type: "idle" },
    loadState: { type: "ready" },
    runState: { type: "idle" },
    messageOrder: ["assistant-1"],
    messagesById: {
      "assistant-1": {
        id: "assistant-1",
        info: { id: "assistant-1", role: "assistant" } as never,
        shadowParts: undefined,
        parts: [
          {
            id: "part-1",
            sessionID: "session-build",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "question",
            state: {
              status: "running",
              input: { questions },
              time: { start: 1 },
            },
          },
        ],
      },
    },
    childSessionsById: {},
    pendingUserMessages: {},
    interactions: {
      permissions: { pending: {}, resolved: {} },
      questions: { pending: {}, answered: {}, rejected: {} },
    },
    unhandledEvents: [],
    sync: {},
  }
}

describe("OpenCodeQuestionBridge", () => {
  afterEach(cleanup)

  beforeEach(() => {
    openCodeEventListeners.clear()
    useOpenCodeQuestions.mockReturnValue([request])
    useOpenCodeRuntimeExtras.mockReturnValue({
      replyToQuestion,
      rejectQuestion,
      state: {
        ...orphanedQuestionState(),
        messageOrder: [],
        messagesById: {},
      },
    })
    useOpenCodeSession.mockReturnValue({ id: "session-build" })
    replyToQuestion.mockResolvedValue(undefined)
    rejectQuestion.mockResolvedValue(undefined)
  })

  it("submits provider-native option labels once through the official runtime", async () => {
    const user = userEvent.setup()
    let finishReply!: () => void
    replyToQuestion.mockImplementation(
      () => new Promise<void>((resolve) => (finishReply = resolve))
    )

    render(
      <OpenCodeQuestionBridge
        locale="en"
        client={createClient()}
        fallback={<div>Default composer</div>}
      />
    )

    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByText("Default composer")).toBeNull()
    expect(
      document.querySelector('[data-slot="question-composer"]')
    ).toBeTruthy()
    expect(document.querySelector('[data-slot="tool-chrome"]')).toHaveAttribute(
      "data-state",
      "pending"
    )
    expect(document.querySelector('[data-slot="option-list"]')).toBeTruthy()
    expect(screen.queryByText("Answer needed")).toBeNull()
    expect(
      screen.queryByText(
        "The Agent is waiting for your input before it continues."
      )
    ).toBeNull()
    const customAnswer = screen.getByRole("button", {
      name: "Type an answer",
    })
    expect(screen.queryByRole("option", { name: "Type an answer" })).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(
      customAnswer.closest('[data-slot="question-answer-block"]')
    ).toBeTruthy()
    await user.click(screen.getByRole("option", { name: /Fast/ }))
    const submit = screen.getByRole("button", { name: "Send answer" })
    await user.click(submit)
    await user.click(submit)

    expect(replyToQuestion).toHaveBeenCalledTimes(1)
    expect(replyToQuestion).toHaveBeenCalledWith("question-1", [["Fast"]])
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled()

    finishReply()
    await waitFor(() =>
      expect(
        screen.queryByText("How should I proceed?")
      ).not.toBeInTheDocument()
    )
    expect(screen.getByText("Default composer")).toBeVisible()
  })

  it("uses question headers as carousel tabs and preserves answers while navigating", async () => {
    const user = userEvent.setup()
    const multiRequest = {
      ...request,
      questions: [
        {
          header: "Checks",
          question: "Which checks should run?",
          options: [
            { label: "Tests", description: "Run tests" },
            { label: "Lint", description: "Run lint" },
          ],
          multiple: true,
        },
        {
          header: "Notes",
          question: "Anything else?",
          options: [],
          custom: true,
        },
      ],
    } satisfies OpenCodeQuestionRequest
    useOpenCodeQuestions.mockReturnValue([multiRequest])

    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    const checksTab = screen.getByRole("tab", { name: "Checks" })
    const notesTab = screen.getByRole("tab", { name: "Notes" })
    expect(screen.getByRole("tablist", { name: "Questions" })).toBeVisible()
    expect(checksTab).toHaveAttribute("aria-selected", "true")
    expect(notesTab).toHaveAttribute("aria-selected", "false")
    expect(screen.queryByText("Anything else?")).toBeNull()
    expect(screen.queryByLabelText("Your answer for Checks")).toBeNull()
    const carouselPanel = document.querySelector(
      '[data-slot="question-carousel-panel"]'
    )
    expect(carouselPanel).toBeTruthy()
    if (!(carouselPanel instanceof HTMLElement)) return
    carouselPanel.scrollTop = 120
    await user.click(screen.getByRole("option", { name: /Tests/ }))
    await user.click(screen.getByRole("option", { name: /Lint/ }))
    await user.click(notesTab)
    await waitFor(() => expect(carouselPanel.scrollTop).toBe(0))
    expect(notesTab).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByText("Which checks should run?")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    const customAnswer = screen.getByRole("button", {
      name: "Type an answer",
    })
    const answerBlock = customAnswer.closest(
      '[data-slot="question-answer-block"]'
    )
    await user.click(customAnswer)
    expect(screen.queryByRole("button", { name: "Type an answer" })).toBeNull()
    expect(answerBlock).toContainElement(
      screen.getByLabelText("Your answer for Notes")
    )
    await user.type(
      screen.getByLabelText("Your answer for Notes"),
      "Keep it calm"
    )
    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByRole("option", { name: /Tests/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("option", { name: /Lint/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByLabelText("Your answer for Notes")).toHaveValue(
      "Keep it calm"
    )
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    expect(replyToQuestion).toHaveBeenCalledWith("question-1", [
      ["Tests", "Lint"],
      ["Keep it calm"],
    ])
  })

  it("submits unanswered carousel questions as skipped answers", async () => {
    const user = userEvent.setup()
    const batchedRequest = {
      ...request,
      questions: [
        {
          header: "Approach",
          question: "How should I proceed?",
          options: request.questions[0]!.options,
          custom: true,
        },
        {
          header: "Notes",
          question: "Anything else?",
          options: [],
          custom: true,
        },
      ],
    } satisfies OpenCodeQuestionRequest
    useOpenCodeQuestions.mockReturnValue([batchedRequest])

    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    const next = screen.getByRole("button", { name: "Next" })
    expect(next).toBeEnabled()
    await user.click(next)
    const send = screen.getByRole("button", { name: "Send answer" })
    expect(send).toBeEnabled()
    await user.click(send)

    expect(replyToQuestion).toHaveBeenCalledWith("question-1", [[], []])
  })

  it("loads questions that were already pending before the runtime subscribed", async () => {
    const user = userEvent.setup()
    useOpenCodeQuestions.mockReturnValue([])
    const client = createClient([request])

    render(<OpenCodeQuestionBridge locale="en" client={client} />)

    expect(await screen.findByText("How should I proceed?")).toBeInTheDocument()
    expect(client.question.list).toHaveBeenCalled()

    await user.click(screen.getByRole("option", { name: /Fast/ }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))
    expect(replyToQuestion).toHaveBeenCalledWith("question-1", [["Fast"]])
  })

  it("renders the normal composer when no question is pending", async () => {
    useOpenCodeQuestions.mockReturnValue([])

    render(
      <OpenCodeQuestionBridge
        locale="en"
        client={createClient()}
        fallback={<div>Default composer</div>}
      />
    )

    expect(await screen.findByText("Default composer")).toBeVisible()
    expect(document.querySelector('[data-slot="question-composer"]')).toBeNull()
  })

  it("does not surface a delayed initial-list response after the active Session changes", async () => {
    const oldList = deferred<{ data: OpenCodeQuestionRequest[] }>()
    let activeSession = { id: "session-build" }
    useOpenCodeQuestions.mockReturnValue([])
    useOpenCodeSession.mockImplementation(() => activeSession)
    const client = {
      question: {
        list: vi
          .fn()
          .mockImplementationOnce(() => oldList.promise)
          .mockResolvedValueOnce({ data: [] }),
      },
    } as unknown as OpencodeClient

    const { rerender } = render(
      <OpenCodeQuestionBridge locale="en" client={client} />
    )
    activeSession = { id: "session-new" }
    rerender(<OpenCodeQuestionBridge locale="en" client={client} />)
    oldList.resolve({ data: [request] })

    await waitFor(() => expect(client.question.list).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("How should I proceed?")).not.toBeInTheDocument()
  })

  it("keeps a failed answer retryable and announces the failure", async () => {
    const user = userEvent.setup()
    replyToQuestion
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)

    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    await user.click(screen.getByRole("option", { name: /Fast/ }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your answer could not be sent."
    )
    await user.click(screen.getByRole("button", { name: "Try again" }))

    expect(replyToQuestion).toHaveBeenCalledTimes(2)
  })

  it("expires a question resolved by another client without resurrecting the listed snapshot", async () => {
    const user = userEvent.setup()
    const client = createClient([request])
    useOpenCodeQuestions.mockReturnValue([request])
    render(<OpenCodeQuestionBridge locale="en" client={client} />)

    expect(await screen.findByText("How should I proceed?")).toBeInTheDocument()
    for (const listener of openCodeEventListeners) {
      listener({
        type: "question.replied",
        sessionId: "session-build",
        properties: { requestID: "question-1" },
      })
    }

    expect(
      await screen.findByText(
        "This question expired before an answer was recorded."
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Fast/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull()
    expect(client.question.list).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText("How should I proceed?")).toBeNull()
    expect(replyToQuestion).not.toHaveBeenCalled()
  })

  it("does not expire the request when its own provider reply event races the response", async () => {
    const user = userEvent.setup()
    replyToQuestion.mockImplementationOnce(async () => {
      for (const listener of openCodeEventListeners) {
        listener({
          type: "question.replied",
          sessionId: "session-build",
          properties: { requestID: "question-1" },
        })
      }
    })
    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    await user.click(screen.getByRole("option", { name: /Fast/ }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    await waitFor(() =>
      expect(screen.queryByText("How should I proceed?")).toBeNull()
    )
    expect(
      screen.queryByText("This question expired before an answer was recorded.")
    ).toBeNull()
  })

  it("does not expire a locally resolved request before React observes its removal", async () => {
    const user = userEvent.setup()
    const reply = deferred<void>()
    replyToQuestion.mockReturnValueOnce(reply.promise)
    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    await user.click(screen.getByRole("option", { name: /Fast/ }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    await act(async () => {
      reply.resolve()
      await Promise.resolve()
      for (const listener of openCodeEventListeners) {
        listener({
          type: "question.replied",
          sessionId: "session-build",
          properties: { requestID: "question-1" },
        })
      }
    })

    expect(
      screen.queryByText("This question expired before an answer was recorded.")
    ).toBeNull()
  })

  it("does not resurrect the oldest locally resolved request after more than 32 delayed SSE identities", async () => {
    const user = userEvent.setup()
    const requests = Array.from({ length: 33 }, (_, index) => ({
      ...request,
      id: `question-${index + 1}`,
      askedAt: index + 1,
      questions: [
        {
          ...request.questions[0]!,
          question: `Question ${index + 1}`,
        },
      ],
    })) satisfies OpenCodeQuestionRequest[]
    useOpenCodeQuestions.mockReturnValue(requests)
    render(
      <OpenCodeQuestionBridge locale="en" client={createClient(requests)} />
    )

    for (const current of requests) {
      await user.click(await screen.findByRole("option", { name: /Fast/ }))
      await user.click(screen.getByRole("button", { name: "Send answer" }))
      await waitFor(() =>
        expect(screen.queryByText(current.questions[0]!.question)).toBeNull()
      )
    }

    act(() => {
      for (const listener of openCodeEventListeners) {
        listener({
          type: "question.replied",
          sessionId: "session-build",
          properties: { requestID: "question-1" },
        })
      }
    })

    expect(screen.queryByText("Question 1")).toBeNull()
    expect(
      screen.queryByText("This question expired before an answer was recorded.")
    ).toBeNull()
  })

  it("localizes the interaction chrome while preserving provider content", async () => {
    render(<OpenCodeQuestionBridge locale="he" client={createClient()} />)

    expect(screen.queryByText("נדרשת תשובה")).toBeNull()
    expect(document.querySelector('[data-slot="tool-chrome"]')).toHaveAttribute(
      "dir",
      "rtl"
    )
    expect(screen.getByText("How should I proceed?")).toHaveAttribute(
      "dir",
      "auto"
    )
    expect(screen.getByRole("button", { name: "שליחת תשובה" })).toBeVisible()
  })

  it("shows an orphaned question without redundant recovery pretext", async () => {
    useOpenCodeQuestions.mockReturnValue([])
    useOpenCodeRuntimeExtras.mockReturnValue({
      replyToQuestion,
      rejectQuestion,
      state: orphanedQuestionState(),
    })

    render(
      <OpenCodeQuestionBridge
        locale="en"
        client={createClient()}
        fallback={<div>Default composer</div>}
      />
    )

    expect(await screen.findByText("How should I proceed?")).toBeVisible()
    expect(screen.getByText("Default composer")).toBeVisible()
    expect(screen.queryByText("Questions awaiting your reply")).toBeNull()
    expect(
      screen.queryByText(
        "OpenCode restarted before these questions were answered. Reply below in your own words."
      )
    ).toBeNull()
    expect(screen.getByText("Fast")).toBeVisible()
    expect(screen.getByText("Make the smallest safe change")).toBeVisible()
    expect(screen.getAllByRole("option")).toHaveLength(2)
    expect(
      screen
        .getAllByRole("option")
        .every((option) => option.hasAttribute("disabled"))
    ).toBe(true)
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull()
  })

  it("uses the live question tabs for a recovered batch", async () => {
    const user = userEvent.setup()
    useOpenCodeQuestions.mockReturnValue([])
    useOpenCodeRuntimeExtras.mockReturnValue({
      replyToQuestion,
      rejectQuestion,
      state: orphanedQuestionState([
        ...request.questions,
        {
          header: "Notes",
          question: "Anything else?",
          options: [],
          custom: true,
        },
      ]),
    })

    render(
      <OpenCodeQuestionBridge
        locale="en"
        client={createClient()}
        fallback={<div>Default composer</div>}
      />
    )

    expect(
      await screen.findByRole("tablist", { name: "Questions" })
    ).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "Notes" }))
    expect(screen.getByText("Anything else?")).toBeVisible()
    expect(screen.queryByText("How should I proceed?")).toBeNull()
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull()
    expect(screen.getByText("Default composer")).toBeVisible()
  })

  it("rejects the active request only after explicit confirmation", async () => {
    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    await waitFor(() =>
      expect(rejectQuestion).toHaveBeenCalledWith("question-1")
    )
  })

  it("keeps a failed rejection retryable even when no answer is selected", async () => {
    const user = userEvent.setup()
    rejectQuestion
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)

    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    await user.click(screen.getByRole("button", { name: "Discard" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The request could not be discarded."
    )
    const retry = screen.getByRole("button", { name: "Try again" })
    expect(retry).toBeEnabled()
    await user.click(retry)

    expect(rejectQuestion).toHaveBeenCalledTimes(2)
  })

  it("moves RTL question tabs with one key and keeps Home and End deterministic", async () => {
    const tabbedRequest = {
      ...request,
      questions: [
        ...request.questions,
        {
          header: "Notes",
          question: "Anything else?",
          options: [{ label: "Keep", description: "Keep it" }],
          custom: false,
        },
        {
          header: "Finish",
          question: "Ready?",
          options: [{ label: "Yes", description: "Continue" }],
          custom: false,
        },
      ],
    } satisfies OpenCodeQuestionRequest
    useOpenCodeQuestions.mockReturnValue([tabbedRequest])

    render(<OpenCodeQuestionBridge locale="he" client={createClient()} />)

    const first = screen.getByRole("tab", { name: "Approach" })
    const last = screen.getByRole("tab", { name: "Finish" })
    first.focus()
    fireEvent.keyDown(first, { key: "ArrowRight" })
    expect(screen.getByRole("tab", { name: "Finish" })).toHaveFocus()
    expect(screen.getByText("Ready?")).toBeVisible()

    fireEvent.keyDown(screen.getByRole("tab", { name: "Finish" }), {
      key: "Home",
    })
    expect(screen.getByRole("tab", { name: "Approach" })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole("tab", { name: "Approach" }), {
      key: "End",
    })
    expect(last).toHaveFocus()
  })

  it("does not submit a question batch when an option is selected by keyboard", async () => {
    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    const option = screen.getByRole("option", { name: /Fast/ })
    option.focus()
    fireEvent.keyDown(option, { key: "Enter" })

    expect(option).toHaveAttribute("aria-selected", "true")
    expect(replyToQuestion).not.toHaveBeenCalled()
  })

  it("commits custom Enter by focusing the next action without activating it", async () => {
    const user = userEvent.setup()
    const batchedRequest = {
      ...request,
      questions: [
        {
          header: "Approach",
          question: "How should I proceed?",
          options: [],
          custom: true,
        },
        {
          header: "Notes",
          question: "Anything else?",
          options: [{ label: "Keep", description: "Keep it" }],
          custom: false,
        },
      ],
    } satisfies OpenCodeQuestionRequest
    useOpenCodeQuestions.mockReturnValue([batchedRequest])

    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)
    await user.click(screen.getByRole("button", { name: "Type an answer" }))
    const input = screen.getByRole("textbox")
    await user.type(input, "custom answer")
    fireEvent.keyDown(input, { key: "Enter" })

    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus()
    expect(replyToQuestion).not.toHaveBeenCalled()
    expect(input).toHaveValue("custom answer")
  })

  it("protects custom input from IME and repeated Enter activation", async () => {
    const user = userEvent.setup()
    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)
    await user.click(screen.getByRole("button", { name: "Type an answer" }))
    const input = screen.getByRole("textbox")

    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: "Enter", repeat: true })
    expect(input).toHaveFocus()
    expect(replyToQuestion).not.toHaveBeenCalled()
  })

  it("focuses the destination answer control after Next and Back", async () => {
    const user = userEvent.setup()
    const batchedRequest = {
      ...request,
      questions: [
        {
          header: "Approach",
          question: "How should I proceed?",
          options: [{ label: "Fast", description: "Small" }],
          custom: true,
        },
        {
          header: "Notes",
          question: "Anything else?",
          options: [{ label: "Keep", description: "Keep it" }],
          custom: true,
        },
      ],
    } satisfies OpenCodeQuestionRequest
    useOpenCodeQuestions.mockReturnValue([batchedRequest])
    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByRole("option", { name: /Keep/ })).toHaveFocus()
    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByRole("option", { name: /Fast/ })).toHaveFocus()
  })

  it("retains the answer across a failed response and retries with the captured request", async () => {
    const user = userEvent.setup()
    replyToQuestion
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)
    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    await user.click(screen.getByRole("option", { name: /Fast/ }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))
    await user.click(await screen.findByRole("button", { name: "Try again" }))

    expect(replyToQuestion).toHaveBeenNthCalledWith(2, "question-1", [["Fast"]])
  })

  it("consumes Escape inside the question composer without discarding or submitting", async () => {
    const user = userEvent.setup()
    render(<OpenCodeQuestionBridge locale="en" client={createClient()} />)
    const option = screen.getByRole("option", { name: /Fast/ })
    option.focus()
    fireEvent.keyDown(option, { key: "Escape" })
    expect(replyToQuestion).not.toHaveBeenCalled()
    expect(rejectQuestion).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Type an answer" }))
    const input = screen.getByRole("textbox")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(replyToQuestion).not.toHaveBeenCalled()
    expect(rejectQuestion).not.toHaveBeenCalled()
  })

  it("keeps a focused active answer when an incoming request is added", async () => {
    const user = userEvent.setup()
    const incoming = {
      ...request,
      id: "question-2",
      askedAt: 0,
      questions: [
        {
          header: "Incoming",
          question: "A newer request",
          options: [{ label: "Later", description: "Wait" }],
          custom: false,
        },
      ],
    } satisfies OpenCodeQuestionRequest
    useOpenCodeQuestions.mockReturnValue([request])
    const { rerender } = render(
      <OpenCodeQuestionBridge locale="en" client={createClient()} />
    )
    await user.click(screen.getByRole("button", { name: "Type an answer" }))
    const input = screen.getByRole("textbox")
    await user.type(input, "keep this")
    useOpenCodeQuestions.mockReturnValue([request, incoming])
    rerender(<OpenCodeQuestionBridge locale="en" client={createClient()} />)

    expect(screen.getByLabelText("Your answer for Approach")).toHaveValue(
      "keep this"
    )
    expect(screen.getByLabelText("Your answer for Approach")).toHaveFocus()
    expect(screen.queryByText("A newer request")).toBeNull()
  })

  it("does not let a pending response from an old Session settle its replacement", async () => {
    const user = userEvent.setup()
    const pending = deferred<void>()
    const oldSession = { id: "session-build" }
    const replacement = {
      ...request,
      id: "question-1",
      sessionID: "session-new",
      questions: [
        {
          header: "Replacement",
          question: "Should this remain pending?",
          options: [{ label: "Keep", description: "Wait" }],
          custom: false,
        },
      ],
    } satisfies OpenCodeQuestionRequest
    useOpenCodeSession.mockImplementation(() => oldSession)
    replyToQuestion.mockImplementationOnce(() => pending.promise)
    useOpenCodeQuestions.mockReturnValue([request])
    const { rerender } = render(
      <OpenCodeQuestionBridge locale="en" client={createClient()} />
    )
    await user.click(screen.getByRole("option", { name: /Fast/ }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    useOpenCodeSession.mockImplementation(() => ({ id: "session-new" }))
    useOpenCodeQuestions.mockReturnValue([replacement])
    rerender(<OpenCodeQuestionBridge locale="en" client={createClient()} />)
    expect(screen.getByText("Should this remain pending?")).toBeVisible()
    expect(screen.getByRole("button", { name: "Send answer" })).toBeEnabled()
    pending.resolve()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send answer" })).toBeEnabled()
    )
  })
})
