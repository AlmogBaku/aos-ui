import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import { RuntimeQuestionComposer } from "./question-composer"

afterEach(cleanup)

const request: RuntimeQuestionRequest = {
  kind: "question",
  requestId: "question-1",
  sessionId: "session-build",
  questions: [
    {
      header: "Approach",
      prompt: "How should I proceed?",
      options: [
        { label: "Fast", description: "Make the smallest safe change" },
      ],
      custom: true,
    },
  ],
}

describe("RuntimeQuestionComposer", () => {
  it.each([
    ["en", "Question", "Question 2"],
    ["he", "\u05e9\u05d0\u05dc\u05d4", "\u05e9\u05d0\u05dc\u05d4 2"],
  ] as const)(
    "names an unlabeled question in %s, because the provider sent no label",
    (locale, single, second) => {
      const unlabeled: RuntimeQuestionRequest = {
        ...request,
        questions: [{ prompt: "How should I proceed?", options: [] }],
      }
      const props = {
        locale,
        interactions: {
          respond: vi.fn().mockResolvedValue(undefined),
          reject: vi.fn().mockResolvedValue(undefined),
        },
        onResponsePending: vi.fn(),
        onResolved: vi.fn(),
        onDismissExpired: vi.fn(),
      }
      render(<RuntimeQuestionComposer {...props} request={unlabeled} />)
      expect(screen.getByText(single)).toBeInTheDocument()

      cleanup()
      render(
        <RuntimeQuestionComposer
          {...props}
          request={{
            ...request,
            questions: [
              { prompt: "First?", options: [] },
              { prompt: "Second?", options: [] },
            ],
          }}
        />
      )
      expect(screen.getByRole("tab", { name: second })).toBeInTheDocument()
    }
  )

  it.each([false, true])(
    "preserves distinct option values when labels repeat (multiple=%s)",
    async (multiple) => {
      const user = userEvent.setup()
      const duplicateLabels: RuntimeQuestionRequest = {
        ...request,
        questions: [
          {
            header: "Destination",
            prompt: "Choose a destination",
            multiple,
            options: [
              {
                label: "Continue",
                value: "first",
                description: "First destination",
              },
              {
                label: "Continue",
                value: "second",
                description: "Second destination",
              },
            ],
          },
        ],
      }
      const interactions = {
        respond: vi.fn().mockResolvedValue(undefined),
        reject: vi.fn().mockResolvedValue(undefined),
      }
      render(
        <RuntimeQuestionComposer
          locale="en"
          request={duplicateLabels}
          interactions={interactions}
          onResponsePending={vi.fn()}
          onResolved={vi.fn()}
          onDismissExpired={vi.fn()}
        />
      )
      const first = screen.getByRole("option", { name: /First destination/ })
      const second = screen.getByRole("option", { name: /Second destination/ })
      await user.click(second)
      expect(second).toHaveAttribute("aria-selected", "true")
      expect(first).toHaveAttribute("aria-selected", "false")
      if (multiple) await user.click(first)
      await user.click(screen.getByRole("button", { name: "Send answer" }))
      expect(interactions.respond).toHaveBeenCalledWith(duplicateLabels, {
        kind: "question",
        answers: [multiple ? ["second", "first"] : ["second"]],
      })
    }
  )
  it("submits selected labels through the neutral interaction adapter", async () => {
    const user = userEvent.setup()
    const interactions: Pick<RuntimeInteractionAdapter, "respond" | "reject"> =
      {
        respond: vi.fn().mockResolvedValue(undefined),
        reject: vi.fn().mockResolvedValue(undefined),
      }

    render(
      <RuntimeQuestionComposer
        locale="en"
        request={request}
        interactions={interactions}
        onResponsePending={vi.fn()}
        onResolved={vi.fn()}
        onDismissExpired={vi.fn()}
      />
    )

    await user.click(screen.getByRole("option", { name: /Fast/ }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    expect(interactions.respond).toHaveBeenCalledWith(request, {
      kind: "question",
      answers: [["Fast"]],
    })
  })

  it("offers Other beside the provider's options and submits the typed text", async () => {
    const user = userEvent.setup()
    const interactions = {
      respond: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
    }

    render(
      <RuntimeQuestionComposer
        locale="en"
        request={request}
        interactions={interactions}
        onResponsePending={vi.fn()}
        onResolved={vi.fn()}
        onDismissExpired={vi.fn()}
      />
    )

    expect(screen.getByRole("option", { name: /Fast/ })).toBeVisible()
    expect(
      screen.queryByRole("textbox", { name: "Other answer for Approach" })
    ).toBeNull()

    await user.click(
      screen.getByRole("button", { name: "Other (type your answer)" })
    )
    await user.type(
      screen.getByRole("textbox", { name: "Other answer for Approach" }),
      "Pair on it first"
    )
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    expect(interactions.respond).toHaveBeenCalledWith(request, {
      kind: "question",
      answers: [["Pair on it first"]],
    })
  })

  it("submits selected options together with the typed Other answer", async () => {
    const user = userEvent.setup()
    const multiSelect: RuntimeQuestionRequest = {
      ...request,
      questions: [
        {
          header: "Amenities",
          prompt: "Which amenities do you use?",
          multiple: true,
          custom: true,
          options: [{ label: "Gym" }, { label: "Pool" }],
        },
      ],
    }
    const interactions = {
      respond: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
    }

    render(
      <RuntimeQuestionComposer
        locale="en"
        request={multiSelect}
        interactions={interactions}
        onResponsePending={vi.fn()}
        onResolved={vi.fn()}
        onDismissExpired={vi.fn()}
      />
    )

    await user.click(screen.getByRole("option", { name: "Gym" }))
    await user.click(
      screen.getByRole("button", { name: "Other (type your answer)" })
    )
    await user.type(
      screen.getByRole("textbox", { name: "Other answer for Amenities" }),
      "Bike storage"
    )
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    expect(interactions.respond).toHaveBeenCalledWith(multiSelect, {
      kind: "question",
      answers: [["Gym", "Bike storage"]],
    })
  })

  it("localizes the Other row and its input in Hebrew", async () => {
    const user = userEvent.setup()

    render(
      <RuntimeQuestionComposer
        locale="he"
        request={request}
        interactions={{
          respond: vi.fn().mockResolvedValue(undefined),
          reject: vi.fn().mockResolvedValue(undefined),
        }}
        onResponsePending={vi.fn()}
        onResolved={vi.fn()}
        onDismissExpired={vi.fn()}
      />
    )

    const other = screen.getByRole("button", { name: "אחר (הקלידו תשובה)" })
    expect(other).toBeVisible()
    await user.click(other)
    expect(
      screen.getByRole("textbox", { name: "תשובה אחרת עבור Approach" })
    ).toBeVisible()
  })

  it("refuses to send an empty Other answer", async () => {
    const user = userEvent.setup()
    const interactions = {
      respond: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
    }

    render(
      <RuntimeQuestionComposer
        locale="en"
        request={request}
        interactions={interactions}
        onResponsePending={vi.fn()}
        onResolved={vi.fn()}
        onDismissExpired={vi.fn()}
      />
    )

    await user.click(
      screen.getByRole("button", { name: "Other (type your answer)" })
    )
    await user.type(
      screen.getByRole("textbox", { name: "Other answer for Approach" }),
      "   "
    )

    const send = screen.getByRole("button", { name: "Send answer" })
    expect(send).toBeDisabled()
    fireEvent.click(send)
    expect(interactions.respond).not.toHaveBeenCalled()
  })
})
