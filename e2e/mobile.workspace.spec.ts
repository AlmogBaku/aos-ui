import type { Locator } from "@playwright/test"

import { expect, test, type Page } from "./test"
import { exerciseAgentManagement } from "./agent-management"
import { exerciseSessionTabs } from "./session-tabs"

for (const locale of ["en", "he"] as const) {
  test(`mobile Session tabs and identity in ${locale}`, async ({ page }) => {
    await exerciseSessionTabs(page, true, locale)
  })
  test(`Manage Agents supports visibility and creation in ${locale}`, async ({
    page,
  }) => {
    await exerciseAgentManagement(page, true, locale)
  })
}

async function expectMinimumTouchTarget(locator: Locator) {
  const box = await locator.boundingBox()

  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
}

async function activeRegion(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return null
    return active
      .closest<HTMLElement>(
        "[data-keyboard-region], [data-keyboard-transcript], [data-keyboard-composer]"
      )
      ?.getAttribute("data-keyboard-region")
  })
}

test("coarse-pointer workspace controls have 44px touch targets", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches))
    .toBe(true)

  await expectMinimumTouchTarget(
    page.getByRole("button", { name: "Open Agents" })
  )
  await expectMinimumTouchTarget(
    page.getByRole("button", { name: "Open Agent details" })
  )
  await expectMinimumTouchTarget(
    page.getByRole("button", { name: "New session" })
  )
  await expectMinimumTouchTarget(
    page.getByRole("button", { name: "Add attachment" })
  )
  await expectMinimumTouchTarget(
    page.getByRole("button", { name: "Send message" })
  )
})

test("the Agents drawer traps focus and restores its trigger on Escape", async ({
  page,
}) => {
  await page.goto("/en")

  const trigger = page.getByRole("button", { name: "Open Agents" })
  await trigger.click()

  const drawer = page.getByRole("dialog", { name: "Agents" })
  await expect(drawer).toBeVisible()
  await expect(
    drawer.getByRole("button", { name: "Close panel" })
  ).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(drawer).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test("the Agent details drawer opens history and restores focus when dismissed", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeVisible()

  const trigger = page.getByRole("button", {
    name: "Open Agent details: Aster",
  })
  await trigger.click()

  const drawer = page.getByRole("dialog", { name: "Agent details" })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText("Aster", { exact: true })).toBeVisible()
  await expect(
    drawer.getByRole("button", { name: "Open session: Pricing analysis" })
  ).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(drawer).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test("mobile F6 skips CSS-hidden Agents and inspector panes", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeVisible()
  await expect(page.locator('[data-keyboard-region="agents"]')).toBeHidden()
  await expect(page.locator('[data-keyboard-region="inspector"]')).toBeHidden()

  await page.getByRole("button", { name: "Open Agents" }).focus()
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("sessions")
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("transcript")
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("composer")
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("sessions")
})

test("F6 reaches the remounted composer after a question resolves", async ({
  page,
}) => {
  await page.goto("/en")
  const input = page.getByRole("textbox", { name: "Message input" })
  await input.focus()
  await page.keyboard.type("Ask me a question")
  await page.keyboard.press("Enter")

  const question = page.locator('[data-slot="tool-chrome"]').filter({
    has: page.getByRole("heading", {
      name: "Which audience should the brief prioritize?",
      exact: true,
    }),
  })
  await expect(question).toHaveAttribute("data-state", "pending")

  const option = question.getByRole("option", { name: "Product team" })
  await option.focus()
  await page.keyboard.press("Space")
  await expect(question).toHaveAttribute("data-state", "answered")
  await expect(input).toBeVisible()

  await page.getByRole("button", { name: "Open Agents" }).focus()
  await page.keyboard.press("F6")
  await page.keyboard.press("F6")
  await page.keyboard.press("F6")
  await expect(input).toBeFocused()
})

test("Hebrew drawers retain localized labels and open from logical start", async ({
  page,
}) => {
  await page.goto("/he")
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")

  const trigger = page.getByRole("button", { name: "פתיחת רשימת הסוכנים" })
  await trigger.click()

  const drawer = page.getByRole("dialog", { name: "סוכנים" })
  await expect(drawer).toBeVisible()
  await expect(
    drawer.getByRole("button", { name: "סגירת החלונית" })
  ).toBeFocused()

  const drawerBox = await drawer.boundingBox()
  expect(drawerBox).not.toBeNull()
  expect(drawerBox!.x + drawerBox!.width).toBeGreaterThan(
    (await page.viewportSize())!.width - 2
  )

  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
})

test("workspace preferences remain comfortably tappable in the Agents drawer", async ({
  page,
}) => {
  await page.goto("/en")
  await page.getByRole("button", { name: "Open Agents" }).click()

  const drawer = page.getByRole("dialog", { name: "Agents" })
  const lightButton = drawer.getByRole("button", { name: "Light" })
  const localeButton = drawer.getByRole("button", {
    name: "Switch to Hebrew",
  })
  const lightBox = await lightButton.boundingBox()
  const localeBox = await localeButton.boundingBox()

  expect(lightBox).not.toBeNull()
  expect(lightBox!.width).toBeGreaterThanOrEqual(44)
  expect(lightBox!.height).toBeGreaterThanOrEqual(44)
  expect(localeBox).not.toBeNull()
  expect(localeBox!.width).toBeGreaterThanOrEqual(44)
  expect(localeBox!.height).toBeGreaterThanOrEqual(44)
})

for (const tool of ["question", "chart"] as const) {
  test(`Hebrew ${tool} content fits its tool card at 390px and desktop width`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await page.goto("/he")
    await expect(page.getByRole("tablist")).toBeVisible()
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

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect
        .poll(
          async () =>
            content.evaluate((element) => {
              const card = element.closest('[data-slot="tool-chrome"]')!
              const cardBox = card.getBoundingClientRect()
              const style = getComputedStyle(card)
              const start =
                cardBox.left +
                parseFloat(style.borderLeftWidth) +
                parseFloat(style.paddingLeft)
              const end =
                cardBox.right -
                parseFloat(style.borderRightWidth) -
                parseFloat(style.paddingRight)
              const elements = [
                element,
                ...element.querySelectorAll(
                  '[role="option"], [role="option"] .size-4'
                ),
              ]
              return elements.every((node) => {
                const box = node.getBoundingClientRect()
                return (
                  box.width > 0 && box.left >= start - 1 && box.right <= end + 1
                )
              })
            }),
          `complete ${tool} bounds remain inside ToolChrome at ${width}px`
        )
        .toBe(true)
    }
  })
}
