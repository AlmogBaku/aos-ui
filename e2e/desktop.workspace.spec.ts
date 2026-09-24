import { expect, test, type Page } from "./test"
import { exerciseAgentManagement } from "./agent-management"
import { exerciseMessageActions } from "./message-actions"
import { exerciseSessionActions } from "./session-actions"
import { exerciseSessionTabs } from "./session-tabs"

test("desktop Session tabs and identity in en", async ({ page }) => {
  await exerciseSessionTabs(page, false)
})
test("desktop Session rows rename, pin, archive, and delete in en", async ({
  page,
}) => {
  await exerciseSessionActions(page, false)
})
test("desktop message menu copies, edits, and defers to the browser in en", async ({
  page,
}) => {
  await exerciseMessageActions(page, false)
})
test("Manage Agents supports visibility controls in en", async ({ page }) => {
  await exerciseAgentManagement(page, false)
})

const hebrew = {
  agents: "סוכנים",
  sessions: "שיחות",
  conversation: "שיחה",
  openAgents: "פתיחת רשימת הסוכנים",
} as const

async function openWorkspace(page: Page, locale: "en" | "he" = "en") {
  await page.goto(`/${locale}`)
  await expect(page.getByRole("tablist")).toBeVisible()
}

function agentButton(page: Page, name: string) {
  return page.getByRole("button", {
    name: new RegExp(`^${name}(?:,|$)`),
  })
}

test("he workspace buttons are visible and keyboard-navigable at 200% text scale", async ({
  page,
}) => {
  await openWorkspace(page, "he")
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%"
  })

  await expect(
    page.getByRole("button", { name: hebrew.openAgents })
  ).toBeVisible()

  await page.getByRole("button", { name: hebrew.openAgents }).click()
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Aster" })
  ).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("button", { name: hebrew.openAgents })
  ).toBeFocused()
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
  await page.reload()
  await expect(page.getByRole("button", { name: "Dark" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )

  await page.getByRole("button", { name: "System" }).click()
  await expect(page.getByRole("button", { name: "System" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
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
