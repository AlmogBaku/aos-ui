// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import type { RuntimeQuestionRequest } from "@/runtime-adapters/contracts"
import { RuntimeQuestionComposer } from "@/components/runtime-interactions/question-composer"
import { createFixtureInteractions } from "./fixture-interactions"

afterEach(cleanup)

it("renders the Other row when the fixture question request has custom answers", () => {
  const adapter = createFixtureInteractions()
  const request: RuntimeQuestionRequest = {
    kind: "question",
    requestId: "req-fixture",
    sessionId: "thread-aster-market",
    questions: [
      {
        header: "Which audience should the brief prioritize?",
        prompt: "",
        options: [
          { label: "Executive team" },
          { label: "Product team" },
          { label: "Investors" },
        ],
        custom: true,
      },
    ],
  }
  adapter.register(request)

  render(
    <RuntimeQuestionComposer
      locale="en"
      request={request}
      interactions={adapter}
      onResponsePending={() => {}}
      onResolved={() => {}}
      onDismissExpired={() => {}}
    />
  )

  expect(screen.getByText("Other (type your answer)")).toBeInTheDocument()
})
