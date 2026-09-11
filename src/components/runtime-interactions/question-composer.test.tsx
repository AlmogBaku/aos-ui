import { cleanup, render, screen } from "@testing-library/react"
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
})
