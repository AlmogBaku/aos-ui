import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import { RuntimeQuestionComposer } from "./question-composer"

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
  it("submits selected labels through the neutral interaction adapter", async () => {
    const user = userEvent.setup()
    const interactions: RuntimeInteractionAdapter = {
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
