import { expect, test, type Page } from "./test"

const localeCopy = {
  en: {
    conversation: "Conversation",
    messageInput: "Message input",
    sendMessage: "Send message",
    planProgress: "Plan progress",
  },
  he: {
    conversation: "שיחה",
    messageInput: "שדה הודעה",
    sendMessage: "שליחת הודעה",
    planProgress: "התקדמות התוכנית",
  },
} as const

async function openWorkspace(page: Page, locale: "en" | "he" = "en") {
  await page.goto(`/${locale}`)
  await expect(page.getByRole("tablist")).toBeVisible()
}

async function sendPrompt(
  page: Page,
  prompt: string,
  locale: "en" | "he" = "en"
) {
  const copy = localeCopy[locale]
  await page.getByRole("textbox", { name: copy.messageInput }).fill(prompt)
  await page.getByRole("button", { name: copy.sendMessage }).click()
}

for (const locale of ["en", "he"] as const) {
  test(`${locale} rich tools preserve the page and tool heading hierarchy`, async ({
    page,
  }) => {
    await openWorkspace(page, locale)
    await sendPrompt(page, "Ask me a question", locale)

    // Answer in the composer so QuestionRecord becomes visible in the transcript
    const composerLabel = locale === "he" ? "שאלות" : "Questions"
    const sendLabel = locale === "he" ? "שליחת תשובה" : "Send answer"
    const questionComposer = page.getByRole("region", { name: composerLabel })
    await questionComposer.getByRole("option", { name: "Executive team" }).click()
    await questionComposer.getByRole("button", { name: sendLabel }).click()
    await expect(questionComposer).not.toBeVisible()

    const questionChrome = page
      .getByRole("heading", {
        name: "Which audience should the brief prioritize?",
        level: 2,
      })
      .locator("xpath=ancestor::section[1]")

    await expect(
      page.getByRole("heading", {
        name: localeCopy[locale].conversation,
        level: 1,
      })
    ).toBeAttached()
    await expect(
      questionChrome.getByRole("heading", {
        name: "Which audience should the brief prioritize?",
        level: 2,
      })
    ).toBeVisible()
    await sendPrompt(page, "Present a plan", locale)
    const plan = page.locator('[data-slot="inline-plan"]').filter({
      has: page.getByRole("heading", {
        name: "Plan",
        level: 2,
        exact: true,
      }),
    })
    await expect(
      plan.getByRole("heading", { name: "Plan", level: 2 })
    ).toBeVisible()
    await expect(
      plan.getByRole("progressbar", {
        name: localeCopy[locale].planProgress,
      })
    ).toHaveAttribute("aria-valuenow", "20")
  })
}

test("plan steps show and hide correctly under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await openWorkspace(page)
  await sendPrompt(page, "Present a plan")

  const plan = page.locator('[data-slot="inline-plan"]').filter({
    has: page.getByRole("heading", {
      name: "Plan",
      level: 2,
      exact: true,
    }),
  })
  const progress = plan.getByRole("progressbar")
  const moreSteps = plan.getByRole("button", { name: "Show 1 more step" })

  await expect(progress).toBeVisible()

  await moreSteps.click()
  await expect(plan.getByText("Summarize key takeaways")).toBeVisible()

  await page.emulateMedia({ reducedMotion: "reduce" })

  await expect(plan.getByText("Summarize key takeaways")).toBeVisible()

  await moreSteps.click()
  await expect(plan.getByText("Summarize key takeaways")).toBeHidden()
})
