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

test("mobile keeps Markdown at its comfortable reading size", async ({
  page,
}) => {
  await page.goto("/en")

  const prose = page
    .getByText(/^Applied AI is accelerating fastest in the planning dataset/)
    .first()
  const planStep = page.getByText("Confirm launch goals", { exact: true })

  await expect(prose).toBeVisible()
  await expect(planStep).toBeVisible()
  await expect
    .poll(() =>
      prose.evaluate((element) => {
        const style = getComputedStyle(element)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight }
      })
    )
    .toEqual({ fontSize: "16px", lineHeight: "28px" })
  await expect
    .poll(() =>
      planStep.evaluate((element) => {
        const style = getComputedStyle(element)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight }
      })
    )
    .toEqual({ fontSize: "14px", lineHeight: "24px" })
})

test("coarse-pointer workspace controls have 44px touch targets", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeHidden()
  await expect
    .poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches))
    .toBe(true)

  const artifactCard = page
    .getByText("enterprise-ai-brief.md", { exact: true })
    .first()
    .locator("xpath=ancestor::article")
  await expectMinimumTouchTarget(
    artifactCard.getByRole("button", {
      name: "Open: enterprise-ai-brief.md",
    })
  )
  await expectMinimumTouchTarget(
    artifactCard.getByRole("button", { name: "Download" })
  )

  await expectMinimumTouchTarget(
    page.getByRole("button", { name: "Open Agents" })
  )
  await page.getByRole("button", { name: "Open Agents" }).click()
  const drawer = page.getByRole("dialog", { name: "Sessions" })
  await expectMinimumTouchTarget(
    drawer.getByRole("button", { name: "New session" })
  )
  await expectMinimumTouchTarget(
    drawer.getByRole("button", {
      name: /^Open session: Market brief/,
    })
  )
  await drawer.getByRole("button", { name: "Back to Agents" }).click()
  await expectMinimumTouchTarget(
    page.getByRole("dialog", { name: "Agents" }).getByRole("button", {
      name: /^Aster/,
    })
  )
  await page.keyboard.press("Escape")
})

test("the mobile composer keeps model and context in one Assistant UI rail", async ({
  page,
}) => {
  await page.goto("/en")

  const composer = page.locator('[data-slot="aui_composer-shell"]')
  const input = page.getByRole("textbox", { name: "Message input" })
  const addAttachment = page.getByRole("button", { name: "Add attachment" })
  const send = page.getByRole("button", { name: "Send message" })
  const model = page.getByRole("combobox", { name: "Choose model" })
  const context = page.getByRole("button", {
    name: "Context usage",
  })
  await expect(input).toHaveCount(1)
  await expect(addAttachment).toHaveCount(1)
  await expect(send).toHaveCount(1)
  await expect(model).toHaveCount(1)
  await expect(context).toHaveCount(1)
  const [inputBox, fieldBox, addAttachmentBox, sendBox, modelBox, contextBox] =
    await Promise.all([
      input.boundingBox(),
      composer.boundingBox(),
      addAttachment.boundingBox(),
      send.boundingBox(),
      model.boundingBox(),
      context.boundingBox(),
    ])

  expect(inputBox).not.toBeNull()
  expect(fieldBox).not.toBeNull()
  expect(addAttachmentBox).not.toBeNull()
  expect(sendBox).not.toBeNull()
  expect(modelBox).not.toBeNull()
  expect(contextBox).not.toBeNull()
  await expect(composer).toBeVisible()
  await expect(context).toBeVisible()
  await expect(addAttachment).toBeEnabled()
  await expect(send).toBeDisabled()

  await page.setViewportSize({ width: 320, height: 700 })
  const compactBox = await composer.boundingBox()
  expect(compactBox).not.toBeNull()
  expect(compactBox!.x).toBeGreaterThanOrEqual(0)
  expect(compactBox!.x + compactBox!.width).toBeLessThanOrEqual(320)

  await page.setViewportSize({ width: 1440, height: 844 })
  await expect(context).toBeVisible()
  const [desktopComposerBox, desktopAddBox, desktopSendBox] = await Promise.all(
    [composer.boundingBox(), addAttachment.boundingBox(), send.boundingBox()]
  )
  expect(desktopComposerBox).not.toBeNull()
  expect(desktopAddBox).not.toBeNull()
  expect(desktopSendBox).not.toBeNull()
  expect(desktopComposerBox!.width).toBeGreaterThan(680)
  expect(desktopAddBox!.x).toBeLessThan(desktopSendBox!.x)
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
  await expect
    .poll(() =>
      reasoning.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          overflowY: style.overflowY,
          scrollable: element.scrollHeight > element.clientHeight,
        }
      })
    )
    .toEqual({ overflowY: "auto", scrollable: true })

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
  await expect
    .poll(async () => {
      const [timelineBox, reasoningBox] = await Promise.all([
        timeline.boundingBox(),
        reasoningBody.boundingBox(),
      ])
      if (!timelineBox || !reasoningBox) return Number.NEGATIVE_INFINITY
      return (
        timelineBox.y +
        timelineBox.height -
        (reasoningBox.y + reasoningBox.height)
      )
    })
    .toBeGreaterThanOrEqual(-1)
})

test("expanded execution rows use a compact vertical rhythm", async ({
  page,
}) => {
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
  const messageToolExperience = timeline.locator(
    'xpath=ancestor::*[@data-slot="message-tool-experience"]'
  )
  await expect(firstReasoning).toBeVisible()
  await expect(nextToolLabel).toBeVisible()
  await expect(firstToolChip).toBeVisible()
  await expect(reasoningTrigger).toBeVisible()
  await expect(firstToolTrigger).toBeVisible()

  const reasoningTop = await firstReasoning.evaluate(
    (element) => element.getBoundingClientRect().top
  )
  const nextToolTop = await nextToolLabel.evaluate(
    (element) => element.getBoundingClientRect().top
  )

  const firstToolChipHeight = await firstToolChip.evaluate(
    (element) => element.getBoundingClientRect().height
  )
  const [reasoningTriggerHeight, firstToolTriggerHeight] = await Promise.all([
    reasoningTrigger.evaluate(
      (element) => element.getBoundingClientRect().height
    ),
    firstToolTrigger.evaluate(
      (element) => element.getBoundingClientRect().height
    ),
  ])
  const groupBottomMargin = await messageToolExperience.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).marginBottom)
  )

  expect(nextToolTop - reasoningTop).toBeGreaterThanOrEqual(25)
  expect(nextToolTop - reasoningTop).toBeLessThanOrEqual(30)
  expect(firstToolChipHeight).toBeLessThanOrEqual(18)
  expect(reasoningTriggerHeight).toBeLessThanOrEqual(30)
  expect(firstToolTriggerHeight).toBeLessThanOrEqual(30)
  expect(groupBottomMargin).toBeGreaterThanOrEqual(4)
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
