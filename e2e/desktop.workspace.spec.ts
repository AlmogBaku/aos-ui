import { expect, test, type Page } from "./test"
import { exerciseAgentManagement } from "./agent-management"
import { exerciseSessionActions } from "./session-actions"
import { exerciseSessionTabs } from "./session-tabs"

for (const locale of ["en", "he"] as const) {
  test(`desktop Session tabs and identity in ${locale}`, async ({ page }) => {
    await exerciseSessionTabs(page, false, locale)
  })
  test(`desktop Session rows rename, pin, archive, and delete in ${locale}`, async ({
    page,
  }) => {
    await exerciseSessionActions(page, false, locale)
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

test("desktop workspace shows body text and plan steps", async ({ page }) => {
  await openWorkspace(page)

  const prose = page
    .getByText(/^Applied AI is accelerating fastest in the planning dataset/)
    .first()
  const planStep = page.getByText("Confirm launch goals", { exact: true })

  await expect(prose).toBeVisible()
  await expect(planStep).toBeVisible()
})

test("inline artifact cards are visible with fully named action buttons", async ({
  page,
}) => {
  await openWorkspace(page)

  const filename = page
    .getByText("enterprise-ai-brief.md", { exact: true })
    .first()
  const card = filename.locator("xpath=ancestor::article")

  await expect(card).toBeVisible()
  await expect(
    card.getByRole("button", { name: "Open", exact: true })
  ).toHaveCount(0)
})

function agentButton(page: Page, name: string) {
  return page.getByRole("button", {
    name: new RegExp(`^${name}(?:,|$)`),
  })
}

for (const locale of [
  {
    path: "en",
    openAgents: "Open Agents",
  },
  {
    path: "he",
    openAgents: "פתיחת רשימת הסוכנים",
  },
] as const) {
  test(`${locale.path} workspace buttons are visible and keyboard-navigable at 200% text scale`, async ({
    page,
  }) => {
    await openWorkspace(page, locale.path)
    await page.locator("html").evaluate((element) => {
      element.style.fontSize = "200%"
    })

    await expect(
      page.getByRole("button", { name: locale.openAgents })
    ).toBeVisible()

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
  await expect(
    page.getByRole("button", { name: "שיחה חדשה" }).first()
  ).toBeEnabled()
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
  await expect(darkTheme).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Switch to Hebrew" })
  ).toBeVisible()

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

test("Lumen's Session row shows Unread until Activity opens it", async ({
  page,
}) => {
  await openWorkspace(page)
  await page.waitForFunction(() => Boolean(window.__AOS_UI_FIXTURE_WORKSPACE__))

  // The provider reports Lumen's Session unread; Aster owns no unread Session.
  const lumen = agentButton(page, "Lumen")
  await expect(lumen).toHaveAttribute(
    "aria-label",
    "Lumen, Status: Needs attention, Unread"
  )
  await expect(agentButton(page, "Aster")).toHaveAttribute(
    "aria-label",
    `Aster, Status: Running, ${english.selectedAgent}`
  )

  await lumen.click()
  await expect(lumen).toHaveAttribute(
    "aria-label",
    `Lumen, Status: Needs attention, ${english.selectedAgent}, Unread`
  )
  const roadmap = page.getByRole("tab", { name: "Roadmap review" })
  await expect(roadmap).toHaveAttribute("aria-label", "Roadmap review, Unread")

  // Opening the Session from Activity is the read the provider records.
  await page.evaluate(() =>
    window.__AOS_UI_FIXTURE_WORKSPACE__!.publishActivityScenario("question")
  )
  await page.getByRole("button", { name: /^Activity, / }).click()
  await page
    .getByRole("button", { name: "Open: Lumen, Roadmap review" })
    .click()

  await expect(lumen).toHaveAttribute(
    "aria-label",
    `Lumen, Status: Needs attention, ${english.selectedAgent}`
  )
  await expect(
    page.getByRole("tab", { name: "Roadmap review, Unread" })
  ).toHaveCount(0)
  // The wait itself is untouched, so it still counts toward the Activity bell.
  await expect(roadmap.getByTitle("Waiting for input")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Activity, 2 unread", exact: true })
  ).toBeVisible()
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
