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

async function computedMotion(
  locator: ReturnType<Page["locator"]>,
  property: "animationName" | "transitionDuration"
) {
  return locator.evaluate(
    (element, requestedProperty) =>
      getComputedStyle(element)[requestedProperty],
    property
  )
}

for (const locale of ["en", "he"] as const) {
  test(`${locale} rich tools preserve the page and tool heading hierarchy`, async ({
    page,
  }) => {
    await openWorkspace(page, locale)
    await sendPrompt(page, "Ask me a question", locale)

    const questionChrome = page
      .locator('[data-slot="tool-chrome"]')
      .filter({
        has: page.getByRole("heading", {
          name: "Which audience should the brief prioritize?",
          level: 2,
        }),
      })
      .last()

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
    const plan = page.locator('[data-slot="inline-plan"]').last()
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

test("reduced motion disables audited transitions without hiding their state changes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await openWorkspace(page)
  await sendPrompt(page, "Present a plan")

  const plan = page.locator('[data-slot="inline-plan"]').last()
  const progress = plan.getByRole("progressbar").locator(":scope > div").first()
  const moreSteps = plan.getByRole("button", { name: "Show 1 more step" })

  await expect(progress).toBeVisible()
  expect(await computedMotion(progress, "transitionDuration")).not.toBe("0s")

  await moreSteps.click()
  const accordionPanel = plan.locator('[data-slot="accordion-content"]')
  await expect(plan.getByText("Summarize key takeaways")).toBeVisible()
  expect(await computedMotion(accordionPanel, "animationName")).not.toBe("none")

  await page.emulateMedia({ reducedMotion: "reduce" })

  expect(await computedMotion(progress, "transitionDuration")).toBe("0s")
  expect(await computedMotion(accordionPanel, "animationName")).toBe("none")
  await expect(plan.getByText("Summarize key takeaways")).toBeVisible()

  await moreSteps.click()
  await expect(plan.getByText("Summarize key takeaways")).toBeHidden()
})
