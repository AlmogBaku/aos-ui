import type { Locator } from "@playwright/test"

import { expect, test, type Page } from "./test"
import { exerciseAgentManagement } from "./agent-management"
import { exerciseSessionTabs } from "./session-tabs"

for (const locale of ["en", "he"] as const) {
  test(`mobile Session tabs and identity in ${locale}`, async ({ page }) => {
    await exerciseSessionTabs(page, true, locale)
  })
  test(`Manage Agents supports visibility controls in ${locale}`, async ({
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
    const region = active.closest<HTMLElement>(
      "[data-keyboard-region], [data-keyboard-transcript], [data-keyboard-composer]"
    )
    if (!region) return null
    if (region.hasAttribute("data-keyboard-transcript")) return "transcript"
    if (region.hasAttribute("data-keyboard-composer")) return "composer"
    return region.getAttribute("data-keyboard-region")
  })
}

test("coarse-pointer workspace controls have 44px touch targets", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeHidden()
  await expect
    .poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches))
    .toBe(true)

  await expectMinimumTouchTarget(
    page.getByRole("button", { name: "Open Agents" })
  )
  await page.getByRole("button", { name: "Open Agents" }).click()
  const drawer = page.getByRole("dialog", { name: "Sessions" })
  await expectMinimumTouchTarget(
    drawer.getByRole("button", { name: "New session" })
  )
  await page.keyboard.press("Escape")
})

test("the mobile composer keeps model and context in one Assistant UI rail", async ({
  page,
}) => {
  await page.goto("/en")

  const composer = page.locator('[data-slot="aui_composer-shell"]')
  const field = composer.locator('[data-slot="aui_composer-field"]')
  const toolbar = composer.locator('[data-slot="aui_composer-toolbar"]')
  const input = page.getByRole("textbox", { name: "Message input" })
  const addAttachment = page.getByRole("button", { name: "Add attachment" })
  const send = page.getByRole("button", { name: "Send message" })
  const model = page.getByRole("combobox", { name: "Choose model" })
  const context = page.getByRole("button", {
    name: "Context usage: 12,288 of 65,536 tokens",
  })
  const contextValue = composer.getByText("12,288 / 65,536", { exact: true })
  const addAttachmentVisual = addAttachment.locator("span").first()
  const sendVisual = send.locator("span").first()
  await expect(input).toHaveCount(1)
  await expect(addAttachment).toHaveCount(1)
  await expect(send).toHaveCount(1)
  await expect(model).toHaveCount(1)
  await expect(context).toHaveCount(1)
  const [
    inputBox,
    fieldBox,
    toolbarBox,
    addAttachmentBox,
    sendBox,
    modelBox,
    contextBox,
    addAttachmentVisualBox,
    sendVisualBox,
  ] = await Promise.all([
    input.boundingBox(),
    field.boundingBox(),
    toolbar.boundingBox(),
    addAttachment.boundingBox(),
    send.boundingBox(),
    model.boundingBox(),
    context.boundingBox(),
    addAttachmentVisual.boundingBox(),
    sendVisual.boundingBox(),
  ])

  expect(inputBox).not.toBeNull()
  expect(fieldBox).not.toBeNull()
  expect(toolbarBox).not.toBeNull()
  expect(addAttachmentBox).not.toBeNull()
  expect(sendBox).not.toBeNull()
  expect(modelBox).not.toBeNull()
  expect(contextBox).not.toBeNull()
  expect(addAttachmentVisualBox).not.toBeNull()
  expect(sendVisualBox).not.toBeNull()
  await expect(composer).toBeVisible()
  await expect(composer).toHaveCSS("display", "flex")
  await expect(context).toBeVisible()
  await expect(contextValue).toBeHidden()
  expect(addAttachmentBox!.width).toBe(44)
  expect(addAttachmentBox!.height).toBe(44)
  expect(sendBox!.width).toBe(44)
  expect(sendBox!.height).toBe(44)
  expect(modelBox!.height).toBe(44)
  expect(contextBox!.width).toBe(44)
  expect(contextBox!.height).toBe(44)
  await expect(addAttachmentVisual).toHaveCSS("width", "36px")
  await expect(sendVisual).toHaveCSS("width", "36px")
  await expect(input).toHaveAttribute("placeholder", "Message")
  expect(fieldBox!.y + fieldBox!.height).toBeLessThanOrEqual(toolbarBox!.y)
  expect(
    Math.abs(
      sendVisualBox!.y +
        sendVisualBox!.height / 2 -
        (toolbarBox!.y + toolbarBox!.height / 2)
    )
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(
      addAttachmentVisualBox!.y +
        addAttachmentVisualBox!.height / 2 -
        (toolbarBox!.y + toolbarBox!.height / 2)
    )
  ).toBeLessThanOrEqual(1)

  await page.setViewportSize({ width: 320, height: 700 })
  const compactBox = await composer.boundingBox()
  expect(compactBox).not.toBeNull()
  expect(compactBox!.x).toBeGreaterThanOrEqual(0)
  expect(compactBox!.x + compactBox!.width).toBeLessThanOrEqual(320)

  await page.setViewportSize({ width: 1440, height: 844 })
  await expect(composer).toHaveCSS("display", "flex")
  await expect(context).toBeHidden()
  await expect(contextValue).toBeVisible()
  const [desktopComposerBox, desktopAddBox, desktopSendBox] = await Promise.all(
    [composer.boundingBox(), addAttachment.boundingBox(), send.boundingBox()]
  )
  expect(desktopComposerBox).not.toBeNull()
  expect(desktopAddBox).not.toBeNull()
  expect(desktopSendBox).not.toBeNull()
  expect(desktopComposerBox!.width).toBeGreaterThan(680)
  expect(desktopAddBox!.x).toBeLessThan(desktopSendBox!.x)
})

test("a Hebrew artifact opens in the focus-managed full-screen viewer", async ({
  page,
}) => {
  await page.goto("/he")
  await expect(page.getByText("enterprise-ai-brief.md").first()).toBeVisible()

  const open = page.getByRole("button", { name: "פתיחה" }).first()
  await open.click()

  const viewer = page.getByRole("dialog", {
    name: "תצוגה מקדימה של התוצר",
  })
  await expect(
    viewer.locator('section[aria-label="תצוגה מקדימה של התוצר"]')
  ).toHaveAttribute("dir", "rtl")
  await expect(viewer.getByText("Enterprise AI brief")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(open).toBeFocused()
})

test("mobile attachment previews span the composer above its controls", async ({
  page,
}) => {
  await page.goto("/en")

  const composer = page.locator('[data-slot="aui_composer-shell"]')
  const attachments = composer.locator(".aui-composer-attachments")
  const field = composer.locator('[data-slot="aui_composer-field"]')
  await attachments.evaluate((element) => {
    const preview = document.createElement("div")
    preview.style.width = "56px"
    preview.style.height = "56px"
    element.append(preview)
  })
  await expect(attachments).toBeVisible()

  const [composerBox, attachmentsBox, fieldBox] = await Promise.all([
    composer.boundingBox(),
    attachments.boundingBox(),
    field.boundingBox(),
  ])
  expect(composerBox).not.toBeNull()
  expect(attachmentsBox).not.toBeNull()
  expect(fieldBox).not.toBeNull()
  expect(attachmentsBox!.width).toBeGreaterThan(composerBox!.width * 0.9)
  expect(attachmentsBox!.y + attachmentsBox!.height).toBeLessThanOrEqual(
    fieldBox!.y
  )
})

test("message virtualization starts only at the workspace desktop boundary", async ({
  page,
}) => {
  await page.goto("/en")
  const message = page.locator('[data-role="assistant"]').first()

  await page.setViewportSize({ width: 900, height: 844 })
  await expect(page.getByRole("tablist")).toBeHidden()
  await expect(message).toHaveCSS("content-visibility", "visible")

  await page.setViewportSize({ width: 1056, height: 844 })
  await expect(page.getByRole("tablist")).toBeVisible()
  await expect(message).toHaveCSS("content-visibility", "auto")
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
  await expect(input).toBeFocused()
})

test("Hebrew drawers retain localized labels and open from logical start", async ({
  page,
}) => {
  await page.goto("/he")
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")

  const trigger = page.getByRole("button", { name: "פתיחת רשימת הסוכנים" })
  await trigger.click()

  const drawer = page.getByRole("dialog", { name: "שיחות" })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole("heading", { name: "Aster" })).toBeFocused()

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

  let drawer = page.getByRole("dialog", { name: "Sessions" })
  await drawer.getByRole("button", { name: "Back to Agents" }).click()
  drawer = page.getByRole("dialog", { name: "Agents" })
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
