import { expect, test } from "./test"
import { createProviderMock } from "./support/provider-mock"

const question = {
  id: "keyboard-batch-question",
  sessionID: "session-research",
  questions: [
    {
      header: "Audience",
      question: "Who should read this brief?",
      options: [
        { label: "Leaders", description: "Decision makers" },
        { label: "Builders", description: "People implementing it" },
      ],
      custom: true,
    },
    {
      header: "Format",
      question: "What format should the brief use?",
      options: [
        { label: "Memo", description: "A concise written brief" },
        { label: "Slides", description: "A presentation-ready outline" },
      ],
      custom: true,
    },
  ],
}

test("question batches isolate Escape and retain keyboard focus while advancing", async ({
  page,
}) => {
  const provider = createProviderMock({ mode: "opencode", port: 4197 })
  await provider.start()
  provider.enqueueQuestion(question)

  try {
    await page.goto("/en")
    await expect
      .poll(() => provider.requests.map((request) => request.path))
      .toContain("/question")
    const questions = page.locator('[data-slot="question-composer"]')
    await expect(questions).toBeVisible()
    await expect(
      questions.getByText("Who should read this brief?", { exact: true })
    ).toBeVisible()

    const firstTab = questions.getByRole("tab", { name: /Audience/ })
    const secondTab = questions.getByRole("tab", { name: /Format/ })
    await firstTab.focus()
    await page.keyboard.press("ArrowRight")
    await expect(secondTab).toBeFocused()
    await expect(secondTab).toHaveAttribute("aria-selected", "true")
    await expect(
      questions.getByText("What format should the brief use?", { exact: true })
    ).toBeVisible()

    await page.keyboard.press("ArrowLeft")
    await expect(firstTab).toBeFocused()
    const leaders = questions.getByRole("option", { name: /^Leaders/ })
    await leaders.focus()
    await page.keyboard.press("Space")
    await expect(leaders).toHaveAttribute("aria-selected", "true")
    const next = questions.getByRole("button", { name: "Next" })
    await next.focus()
    await page.keyboard.press("Enter")
    await expect(firstTab).toHaveAttribute("data-answered", "true")
    await expect(secondTab).toHaveAttribute("aria-selected", "true")

    const slides = questions.getByRole("option", { name: /^Slides/ })
    await slides.focus()
    await page.keyboard.press("Space")
    await expect(slides).toHaveAttribute("aria-selected", "true")
    await page.keyboard.press("Escape")
    await expect(slides).toHaveAttribute("aria-selected", "false")
    await expect(questions).toBeVisible()
    await expect(slides).toBeFocused()

    await page.keyboard.press("Space")
    const send = questions.getByRole("button", { name: "Send answer" })
    await send.focus()
    await page.keyboard.press("Enter")
    await expect.poll(() => provider.pendingQuestions).toHaveLength(0)
    await expect(questions).toHaveCount(0)
  } finally {
    await provider.stop()
  }
})
