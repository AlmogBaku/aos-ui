import { expect, type Page } from "./test"

export async function exerciseSessionTabs(
  page: Page,
  mobile: boolean,
  locale: "en" | "he"
) {
  const copy =
    locale === "en"
      ? {
          drawer: "Open Agents",
          identity: "Open Agent details",
          details: "Agent details",
          status: "Status: Running",
          newSession: "New session",
          actions: "Session actions",
          close: "Close tab",
          closeSession: "Close session",
          undo: "Undo",
          closed: "Tab closed",
        }
      : {
          drawer: "פתיחת רשימת הסוכנים",
          identity: "פתיחת פרטי הסוכן",
          details: "פרטי הסוכן",
          status: "מצב: פעיל",
          newSession: "שיחה חדשה",
          actions: "פעולות שיחה",
          close: "סגירת לשונית",
          closeSession: "סגירת שיחה",
          undo: "ביטול",
          closed: "הלשונית נסגרה",
        }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`/${locale}`)
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  if (mobile) {
    const drawer = page.getByRole("button", { name: copy.drawer })
    const bounds = await drawer.boundingBox()
    expect(bounds!.width).toBeGreaterThanOrEqual(44)
    expect(bounds!.height).toBeGreaterThanOrEqual(44)
    const identity = page.getByRole("button", {
      name: `${copy.identity}: Aster`,
    })
    await expect(identity).toContainText("Aster")
    await expect(identity).toHaveAccessibleDescription(copy.status)
    await expect(identity.locator('[data-agent-symbol="spark"]')).toBeVisible()
    await identity.click()
    await expect(page.getByRole("dialog", { name: copy.details })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(identity).toBeFocused()
    await expect(
      page.locator(`button[aria-label^="${copy.closeSession}:"]`).first()
    ).toBeHidden()
  } else {
    const close = page.getByRole("button", {
      name:
        locale === "en"
          ? "Close session: Market brief"
          : "סגירת שיחה: Market brief",
    })
    await page.mouse.move(0, 0)
    await expect(close).toHaveCSS("opacity", "0")
    await expect(close).toHaveCSS("pointer-events", "none")
    await page.getByRole("tab", { name: "Market brief" }).hover()
    await expect(close).toHaveCSS("opacity", "1")
    await expect(close).toHaveCSS("pointer-events", "auto")
    await close.focus()
    await page.mouse.move(0, 0)
    await expect(close).toHaveCSS("opacity", "1")
    await expect(close).toHaveCSS("transition-duration", "0s")
  }
  // The workspace uses a named inline-size container. Account for the page's
  // outer padding so the container itself reaches the 64rem desktop layout.
  if (!mobile) await page.setViewportSize({ width: 1056, height: 1000 })
  expect(
    await page
      .locator("[data-tab-viewport]")
      .evaluate((el) => el.scrollWidth > el.clientWidth)
  ).toBe(true)
  const actions = page.locator("[data-session-actions]")
  const before = await actions.boundingBox()
  await page.locator("[data-tab-viewport]").evaluate((el) => {
    el.scrollLeft = el.scrollWidth * (document.dir === "rtl" ? -1 : 1)
  })
  expect(await actions.boundingBox()).toEqual(before)
  await expect(
    actions.getByRole("button", { name: copy.newSession })
  ).toBeVisible()
  await page
    .getByRole("button", { name: `${copy.actions}: Market brief` })
    .click()
  await expect(page.getByRole("menuitem", { name: copy.close })).toBeVisible()
  await page.screenshot({
    path: `.superpowers/sdd/agent-workspace-polish/task-3-${locale}-${mobile ? "mobile" : "desktop"}-menu.png`,
  })
  await page.getByRole("menuitem", { name: copy.close }).click()
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveCount(0)
  await expect(
    page.getByRole("tab", { name: "Launch review" })
  ).toHaveAttribute("aria-selected", "true")
  await expect(
    page.getByRole("status").filter({ hasText: copy.closed })
  ).toContainText("Market brief")
  await page.getByRole("button", { name: copy.undo, exact: true }).click()
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(page.getByRole("tab", { name: "Market brief" })).toBeFocused()
  await page
    .getByRole("button", { name: `${copy.actions}: Market brief` })
    .click()
  await page.getByRole("menuitem", { name: copy.close }).click()
  await page.waitForTimeout(7000)
  await expect(
    page.getByRole("button", { name: copy.undo, exact: true })
  ).toBeVisible()
  await page.screenshot({
    path: `.superpowers/sdd/agent-workspace-polish/task-3-${locale}-${mobile ? "mobile" : "desktop"}-undo.png`,
  })
  await expect(
    page.getByRole("button", { name: copy.undo, exact: true })
  ).toHaveCount(0, { timeout: 2000 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  if (mobile) {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(
      page.locator(`button[aria-label^="${copy.closeSession}:"]`).first()
    ).toBeHidden()
    await expect(
      page.getByRole("button", { name: `${copy.actions}: Launch review` })
    ).toBeVisible()
  }
}
