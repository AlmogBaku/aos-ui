import type { Locator } from "@playwright/test"

import { expect, test, type Page } from "./test"
import { exerciseAgentManagement } from "./agent-management"
import { exerciseSessionTabs } from "./session-tabs"

for (const locale of ["en", "he"] as const) {
  test(`desktop Session tabs and identity in ${locale}`, async ({ page }) => {
    await exerciseSessionTabs(page, false, locale)
  })
  test(`Manage Agents supports visibility controls in ${locale}`, async ({
    page,
  }) => {
    await exerciseAgentManagement(page, false, locale)
  })
}

const english = {
  agents: "Agents",
  sessions: "Sessions",
  conversation: "Conversation",
  selectedAgent: "Selected Agent",
  openSession: "Open session",
  closeSession: "Close session",
  messageInput: "Message input",
  sendMessage: "Send message",
  stopGenerating: "Stop generating",
} as const

const hebrew = {
  agents: "סוכנים",
  sessions: "שיחות",
  conversation: "שיחה",
} as const

async function openWorkspace(page: Page, locale: "en" | "he" = "en") {
  await page.goto(`/${locale}`)
  await expect(page.getByRole("tablist")).toBeVisible()
}

test("desktop keeps Markdown compact without shrinking rich output", async ({
  page,
}) => {
  await openWorkspace(page)

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
    .toEqual({ fontSize: "14px", lineHeight: "24px" })
  await expect
    .poll(() =>
      planStep.evaluate((element) => {
        const style = getComputedStyle(element)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight }
      })
    )
    .toEqual({ fontSize: "14px", lineHeight: "24px" })
})

test("inline artifact cards use the compact workspace rhythm", async ({
  page,
}) => {
  await openWorkspace(page)

  const filename = page
    .getByText("enterprise-ai-brief.md", { exact: true })
    .first()
  const card = filename.locator("xpath=ancestor::article")
  const openButton = card.getByRole("button", {
    name: "Open: enterprise-ai-brief.md",
  })

  await expect(card).toBeVisible()
  await expect
    .poll(() =>
      card.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          paddingBlock: style.paddingBlock,
          paddingInline: style.paddingInline,
        }
      })
    )
    .toEqual({ paddingBlock: "8px", paddingInline: "8px" })
  await expect
    .poll(() =>
      openButton.evaluate((element) => element.getBoundingClientRect().height)
    )
    .toBeLessThanOrEqual(40)
  await expect(
    card.getByRole("button", { name: "Open", exact: true })
  ).toHaveCount(0)
  await expect
    .poll(() =>
      card.evaluate((element) => element.getBoundingClientRect().height)
    )
    .toBeLessThanOrEqual(56)
  await expect
    .poll(() =>
      card.evaluate((element) => element.getBoundingClientRect().width)
    )
    .toBeLessThan(600)
})

test.describe("coarse-pointer artifact outputs", () => {
  test.use({ hasTouch: true })

  test("compact artifact actions remain full touch targets", async ({
    page,
  }) => {
    await openWorkspace(page)

    const outputs = page
      .locator("details")
      .filter({ has: page.getByText("Artifacts", { exact: true }) })
    await outputs.locator("summary").click()
    const compactArtifact = outputs.locator("article").first()

    for (const name of ["Open", "Download"]) {
      const box = await compactArtifact
        .getByRole("button", { name })
        .boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThanOrEqual(44)
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
  })
})

function agentButton(page: Page, name: string) {
  return page.getByRole("button", {
    name: new RegExp(`^${name}(?:,|$)`),
  })
}

async function expectInsideViewport(
  page: Page,
  locator: Locator,
  description: string
) {
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()

  expect(box, `${description} should have a rendered box`).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
}

for (const locale of [
  {
    path: "en",
    openAgents: "Open Agents",
    closePanel: "Close panel",
    messageInput: "Message input",
    sendMessage: "Send message",
  },
  {
    path: "he",
    openAgents: "פתיחת רשימת הסוכנים",
    closePanel: "סגירת החלונית",
    messageInput: "שדה הודעה",
    sendMessage: "שליחת הודעה",
  },
] as const) {
  test(`${locale.path} workspace reflows at 200% root text scaling`, async ({
    page,
  }) => {
    await openWorkspace(page, locale.path)
    await page.locator("html").evaluate((element) => {
      element.style.fontSize = "200%"
    })
    await expect
      .poll(() =>
        page
          .locator("html")
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).fontSize)
          )
      )
      .toBe(32)

    await expect(
      page.getByRole("button", { name: locale.openAgents })
    ).toBeVisible()
    await expectInsideViewport(
      page,
      page.getByRole("button", { name: locale.openAgents }),
      locale.openAgents
    )
    await expectInsideViewport(
      page,
      page.getByRole("textbox", { name: locale.messageInput }),
      locale.messageInput
    )
    await expectInsideViewport(
      page,
      page.getByRole("button", { name: locale.sendMessage }),
      locale.sendMessage
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth
        )
      )
      .toBe(true)

    await page.getByRole("button", { name: locale.openAgents }).click()
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: "Aster" })
    ).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(
      page.getByRole("button", { name: locale.openAgents })
    ).toBeFocused()
  })
}

test("English launches as an LTR Agent workspace", async ({ page }) => {
  await openWorkspace(page)

  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr")
  await expect(
    page
      .getByRole("complementary", { name: english.agents })
      .getByText("AOS", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: english.agents })
  ).toBeVisible()
  await expect(
    page.getByRole("tablist", { name: english.sessions })
  ).toBeVisible()
  await expect(
    page.getByRole("main", { name: english.conversation })
  ).toBeVisible()
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(agentButton(page, "Aster")).toHaveAttribute(
    "aria-label",
    `Aster, Status: Running, ${english.selectedAgent}`
  )
})

test("Hebrew launches as a fully localized RTL workspace", async ({ page }) => {
  await openWorkspace(page, "he")

  await expect(page.locator("html")).toHaveAttribute("lang", "he")
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  await expect(
    page.getByRole("navigation", { name: hebrew.agents })
  ).toBeVisible()
  await expect(
    page.getByRole("tablist", { name: hebrew.sessions })
  ).toBeVisible()
  await expect(
    page.getByRole("main", { name: hebrew.conversation })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "שיחה חדשה" })).toBeEnabled()
})

test("the desktop Agent inspector can be collapsed and the preference persists", async ({
  page,
}) => {
  await openWorkspace(page)

  const inspector = page.locator("#workspace-agent-inspector")
  await expect(inspector).toBeVisible()

  await page.getByRole("button", { name: "Hide Agent details" }).click()
  await expect(inspector).toBeHidden()
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Show Agent details" })
  ).toBeVisible()
  await expect(inspector).toBeHidden()

  await page.getByRole("button", { name: "Show Agent details" }).click()
  await expect(inspector).toBeVisible()
})

test("appearance choices are explicit, system-aware, and persisted", async ({
  page,
}) => {
  await openWorkspace(page)

  const darkTheme = page.getByRole("button", { name: "Dark" })
  const locale = page.getByRole("button", { name: "Switch to Hebrew" })
  const [darkThemeBox, localeBox] = await Promise.all([
    darkTheme.boundingBox(),
    locale.boundingBox(),
  ])
  expect(darkThemeBox).not.toBeNull()
  expect(darkThemeBox!.width).toBeGreaterThanOrEqual(44)
  expect(darkThemeBox!.height).toBeGreaterThanOrEqual(44)
  expect(localeBox).not.toBeNull()
  expect(localeBox!.width).toBeGreaterThanOrEqual(44)
  expect(localeBox!.height).toBeGreaterThanOrEqual(44)

  await darkTheme.click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(page.getByRole("button", { name: "Dark" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )

  await page.getByRole("button", { name: "System" }).click()
  await expect(page.locator("html")).toHaveClass(/dark|light/)
})

test("the language control preserves URL context and the selected Session", async ({
  page,
}) => {
  await page.goto("/en?view=compact#thread-market")
  await expect(page.getByRole("tablist")).toBeVisible()
  await page.getByRole("tab", { name: "Launch review" }).click()
  const workspaceUrl = page.url()

  await page.getByRole("button", { name: "Switch to Hebrew" }).click()

  await expect(page).toHaveURL(workspaceUrl)
  await expect(page.locator("html")).toHaveAttribute("lang", "he")
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  await expect(
    page.getByRole("tab", { name: "Launch review" })
  ).toHaveAttribute("aria-selected", "true")
})

test("browser history restores Agent and Session selection", async ({
  page,
}) => {
  await openWorkspace(page)
  await expect(page).toHaveURL(/\/agent-aster\/thread-aster-market$/)
  await agentButton(page, "Mica").click()
  await expect(page).toHaveURL(/\/agent-mica\/thread-mica-quarterly$/)

  await page.goBack()
  await expect(page).toHaveURL(/\/agent-aster\/thread-aster-market$/)
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
})

test("switching Agents restores each Agent's last selected Session", async ({
  page,
}) => {
  await openWorkspace(page)

  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )

  await agentButton(page, "Mica").click()
  await expect(
    page.getByRole("tab", { name: "Quarterly synthesis" })
  ).toHaveAttribute("aria-selected", "true")

  await agentButton(page, "Aster").click()
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
})

test("an older history Session becomes a real tab until it is closed", async ({
  page,
}) => {
  await openWorkspace(page)

  const pricingTab = page.getByRole("tab", { name: "Pricing analysis" })
  await expect(pricingTab).toHaveCount(0)

  await page
    .getByRole("button", {
      name: `${english.openSession}: Pricing analysis`,
    })
    .click()

  await expect(pricingTab).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "Launch review" }).click()
  await expect(pricingTab).toBeVisible()
  await pricingTab.hover()

  await page
    .getByRole("button", {
      name: `${english.closeSession}: Pricing analysis`,
    })
    .click()
  await expect(pricingTab).toHaveCount(0)
})

test("Session tabs use roving focus and direction-aware arrow keys", async ({
  page,
}) => {
  await openWorkspace(page)

  const market = page.getByRole("tab", { name: "Market brief" })
  const launch = page.getByRole("tab", { name: "Launch review" })
  await market.focus()
  await market.press("ArrowDown")
  await expect(market).toBeFocused()
  await market.press("ArrowRight")
  await expect(launch).toBeFocused()
  await expect(launch).toHaveAttribute("aria-selected", "true")

  await page.goto("/he")
  await expect(page.getByRole("tablist")).toBeVisible()
  const rtlMarket = page.getByRole("tab", { name: "Market brief" })
  const rtlLaunch = page.getByRole("tab", { name: "Launch review" })
  await rtlMarket.focus()
  await rtlMarket.press("ArrowLeft")
  await expect(rtlLaunch).toBeFocused()
  await expect(rtlLaunch).toHaveAttribute("aria-selected", "true")
})

test("a response can stream to completion", async ({ page }) => {
  await openWorkspace(page)

  await page
    .getByRole("textbox", { name: english.messageInput })
    .fill("Summarize the next market signal")
  await page.getByRole("button", { name: english.sendMessage }).click()

  const assistantMessages = page.locator('[data-role="assistant"]')
  await expect(assistantMessages.last()).toBeVisible()
  await expect(assistantMessages.last()).not.toBeEmpty()
  await expect(
    page.getByRole("button", { name: english.sendMessage })
  ).toBeVisible()
})

test("an in-flight response can be cancelled without losing the composer", async ({
  page,
}) => {
  await openWorkspace(page)

  const input = page.getByRole("textbox", { name: english.messageInput })
  await input.fill("Start a response that I will cancel")
  await page.getByRole("button", { name: english.sendMessage }).click()

  const cancel = page.getByRole("button", { name: english.stopGenerating })
  await expect(cancel).toBeVisible()
  await cancel.click()

  await expect(cancel).toHaveCount(0)
  await expect(input).toBeVisible()
  await expect(
    page.getByRole("button", { name: english.sendMessage })
  ).toBeVisible()
})
