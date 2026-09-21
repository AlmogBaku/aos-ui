import { expect, test, type Page } from "./test"
import { exerciseAgentManagement } from "./agent-management"
import { exerciseMessageActions } from "./message-actions"
import { exerciseSessionActions } from "./session-actions"
import { exerciseSessionTabs } from "./session-tabs"

for (const locale of ["en", "he"] as const) {
  test(`mobile Session tabs and identity in ${locale}`, async ({ page }) => {
    await exerciseSessionTabs(page, true, locale)
  })
  test(`mobile Session rows rename, pin, and list archived in ${locale}`, async ({
    page,
  }) => {
    await exerciseSessionActions(page, true, locale)
  })
  test(`mobile message menu opens by long press in ${locale}`, async ({
    page,
  }) => {
    await exerciseMessageActions(page, true, locale)
  })
  test(`Manage Agents supports visibility controls in ${locale}`, async ({
    page,
  }) => {
    await exerciseAgentManagement(page, true, locale)
  })
}

async function activeRegion(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return null
    const region = active.closest<HTMLElement>(
      "[data-keyboard-region], [data-keyboard-transcript], [data-keyboard-composer]"
    )
    if (!region) return null
    if (region.hasAttribute("data-keyboard-transcript")) return "transcript"
    if (region.hasAttribute("data-keyboard-composer")) return "composer"
    return region.getAttribute("data-keyboard-region")
  })
}

test("mobile workspace shows body text and plan steps", async ({ page }) => {
  await page.goto("/en")

  const prose = page
    .getByText(/^Applied AI is accelerating fastest in the planning dataset/)
    .first()
  const planStep = page.getByText("Confirm launch goals", { exact: true })

  await expect(prose).toBeVisible()
  await expect(planStep).toBeVisible()
})

test("expanded reasoning remains independently scrollable", async ({
  page,
}) => {
  await page.goto("/en")

  const timeline = page.locator('[data-slot="tool-timeline"]').first()
  await timeline.locator("button").first().click()

  const reasoningTrigger = timeline
    .locator('[data-slot="reasoning-trigger"]')
    .first()
  const reasoningBody = timeline.locator(".aui-reasoning-text-content").first()
  await reasoningTrigger.click()
  await reasoningBody.evaluate((element) => {
    element.textContent = `${"Long reasoning must remain fully inspectable. ".repeat(80)}END`
  })

  const reasoning = timeline.locator('[data-slot="reasoning-text"]').first()
  await expect(reasoning).toBeVisible()

  const threadViewport = page.locator('[data-slot="aui_thread-viewport"]')
  const threadScrollTop = await threadViewport.evaluate(
    (element) => element.scrollTop
  )
  await reasoning.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect
    .poll(() => reasoning.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  await expect
    .poll(() => threadViewport.evaluate((element) => element.scrollTop))
    .toBe(threadScrollTop)
})

test("expanded execution rows render expected elements", async ({ page }) => {
  await page.goto("/en")

  const timeline = page.locator('[data-slot="tool-timeline"]').first()
  await timeline.locator("button").first().click()

  const firstReasoning = timeline
    .getByText("Reasoning", { exact: true })
    .first()
  const nextToolLabel = timeline.getByText("Read", { exact: true }).first()
  const firstToolChip = timeline.getByText("planning-dataset-q1.md", {
    exact: true,
  })
  const reasoningTrigger = timeline
    .locator('[data-slot="reasoning-trigger"]')
    .first()
  const firstToolTrigger = timeline
    .locator('[data-slot="tool-call"] button')
    .first()
  await expect(firstReasoning).toBeVisible()
  await expect(nextToolLabel).toBeVisible()
  await expect(firstToolChip).toBeVisible()
  await expect(reasoningTrigger).toBeVisible()
  await expect(firstToolTrigger).toBeVisible()
})

test("a Hebrew artifact opens in the focus-managed full-screen viewer", async ({
  page,
}) => {
  await page.goto("/he")
  await page
    .getByRole("textbox", { name: "שדה הודעה" })
    .fill("Publish an artifact")
  await page.getByRole("button", { name: "שליחת הודעה" }).click()
  const open = page.getByRole("button", { name: "פתיחה" }).first()
  await expect(open).toBeVisible()
  await open.click()

  const viewer = page.getByRole("dialog", {
    name: "תצוגה מקדימה של התוצר",
  })
  await expect(
    viewer.locator('section[aria-label="תצוגה מקדימה של התוצר"]')
  ).toHaveAttribute("dir", "rtl")
  await expect(viewer).not.toBeEmpty()
  await page.keyboard.press("Escape")
  await expect(open).toBeFocused()
})

test("mobile attachment previews span the composer above its controls", async ({
  page,
}) => {
  await page.goto("/en")

  const composer = page.locator('[data-slot="aui_composer-shell"]')
  await expect(composer).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Add attachment" })
  ).toBeEnabled()
})

test("message virtualization starts only at the workspace desktop boundary", async ({
  page,
}) => {
  await page.goto("/en")
  const message = page.locator('[data-role="assistant"]').first()

  await page.setViewportSize({ width: 900, height: 844 })
  await expect(page.getByRole("tablist")).toBeHidden()
  await expect(message).toBeVisible()

  await page.setViewportSize({ width: 1056, height: 844 })
  await expect(page.getByRole("tablist")).toBeVisible()
  await expect(message).toBeVisible()
})

test("the Sessions drawer traps focus and restores its trigger on Escape", async ({
  page,
}) => {
  await page.goto("/en")

  const trigger = page.getByRole("button", { name: "Open Agents" })
  await trigger.click()

  const drawer = page.getByRole("dialog", { name: "Sessions" })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole("heading", { name: "Aster" })).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(drawer).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test("the navigator browses another Agent and closes after Session selection", async ({
  page,
}) => {
  await page.goto("/en")
  const trigger = page.getByRole("button", { name: "Open Agents" })
  await trigger.click()

  let drawer = page.getByRole("dialog", { name: "Sessions" })
  await drawer.getByRole("button", { name: "Back to Agents" }).click()
  drawer = page.getByRole("dialog", { name: "Agents" })
  await drawer.getByRole("button", { name: /Mica/ }).click()
  drawer = page.getByRole("dialog", { name: "Sessions" })
  await expect(drawer.getByRole("heading", { name: "Mica" })).toBeVisible()
  await drawer
    .getByRole("button", { name: /Open session:/i })
    .first()
    .click()
  await expect(drawer).toHaveCount(0)
  await expect(
    page.getByRole("group", { name: new RegExp("Mica") })
  ).toBeVisible()
})

test("the Sessions drawer marks another Agent's unread Session on the back control", async ({
  page,
}) => {
  await page.goto("/en")
  await page.getByRole("button", { name: "Open Agents" }).click()

  // Aster is selected and holds no unread Session; Lumen's and Nori's are unread.
  const sessions = page.getByRole("dialog", { name: "Sessions" })
  const back = sessions.getByRole("button", { name: "Back to Agents" })
  await expect(back).toHaveAttribute("aria-label", "Back to Agents, Unread")
  await expect(back.getByTitle("Unread")).toBeVisible()

  await back.click()
  const agents = page.getByRole("dialog", { name: "Agents" })
  await expect(
    agents.getByRole("button", { name: /^Lumen,.*Unread$/ })
  ).toBeVisible()
  await expect(
    agents.getByRole("button", { name: /^Aster/ })
  ).not.toHaveAttribute("aria-label", /Unread/)

  await agents.getByRole("button", { name: /^Lumen/ }).click()
  await expect(
    page
      .getByRole("dialog", { name: "Sessions" })
      .getByRole("button", { name: /^Open session: Roadmap review,.*Unread$/ })
  ).toBeVisible()
})

test("mobile F6 skips CSS-hidden Agents and inspector panes", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeHidden()
  await expect(page.locator('[data-keyboard-region="agents"]')).toBeHidden()
  await expect(page.locator('[data-keyboard-region="inspector"]')).toBeHidden()

  await page.getByRole("button", { name: "Open Agents" }).focus()
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("transcript")
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("composer")
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("transcript")
})

test("mobile Return inserts a newline until Send is tapped", async ({
  page,
}) => {
  await page.goto("/en")
  const input = page.getByRole("textbox", { name: "Message input" })

  await input.focus()
  await page.keyboard.type("First line")
  await page.keyboard.press("Enter")
  await page.keyboard.type("Second line")

  await expect(input).toHaveValue("First line\nSecond line")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(input).toHaveValue("")
  await expect(
    page.getByText("First line\nSecond line", { exact: true })
  ).toBeVisible()
})

test("F6 reaches the remounted composer after a question resolves", async ({
  page,
}) => {
  await page.goto("/en")
  const input = page.getByRole("textbox", { name: "Message input" })
  await input.focus()
  await page.keyboard.type("Ask me a question")
  await page.getByRole("button", { name: "Send message" }).click()

  const questionComposer = page.getByRole("region", { name: "Questions" })
  await expect(questionComposer).toBeVisible()

  const option = questionComposer.getByRole("option", { name: "Product team" })
  await option.focus()
  await page.keyboard.press("Space")
  await questionComposer.getByRole("button", { name: "Send answer" }).click()

  await expect(questionComposer).not.toBeVisible()
  await expect(input).toBeVisible()

  await page.getByRole("button", { name: "Open Agents" }).focus()
  await page.keyboard.press("F6")
  await page.keyboard.press("F6")
  await expect(input).toBeFocused()
})

test("Hebrew drawers retain localized labels and return focus on Escape", async ({
  page,
}) => {
  await page.goto("/he")
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")

  const trigger = page.getByRole("button", { name: "פתיחת רשימת הסוכנים" })
  await trigger.click()

  const drawer = page.getByRole("dialog", { name: "שיחות" })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole("heading", { name: "Aster" })).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
})

for (const tool of ["question", "chart"] as const) {
  test(`Hebrew ${tool} tool card appears after a prompt`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await page.goto("/he")
    await expect(page.getByRole("tablist")).toBeHidden()
    await page
      .getByRole("textbox", { name: "שדה הודעה" })
      .fill(tool === "question" ? "Ask me a question" : "Show a chart")
    await page.getByRole("button", { name: "שליחת הודעה" }).click()
    const content = page
      .locator(
        tool === "question"
          ? '[data-slot="option-list"]'
          : '[data-slot="chart"][data-tool-ui-id]'
      )
      .last()
    await expect(content).toBeVisible()
  })
}
