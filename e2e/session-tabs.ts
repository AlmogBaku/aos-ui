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
          sessions: "Sessions",
          agents: "Agents",
          backToAgents: "Back to Agents",
          openSession: "Open session",
          status: "Status: Running",
          newSession: "New session",
          actions: "Session actions",
          removeOpenSession: "Remove from open sessions",
          close: "Close tab",
          closeSession: "Close session",
          undo: "Undo",
          closed: "Tab closed",
        }
      : {
          drawer: "פתיחת רשימת הסוכנים",
          sessions: "שיחות",
          agents: "סוכנים",
          backToAgents: "חזרה לסוכנים",
          openSession: "פתיחת שיחה",
          status: "מצב: פעיל",
          newSession: "שיחה חדשה",
          actions: "פעולות שיחה",
          removeOpenSession: "הסרה מהשיחות הפתוחות",
          close: "סגירת לשונית",
          closeSession: "סגירת שיחה",
          undo: "ביטול",
          closed: "הלשונית נסגרה",
        }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`/${locale}`)
  if (mobile) {
    await expect(
      page.getByRole("tablist", { name: copy.sessions })
    ).toBeHidden()
    const drawerTrigger = page.getByRole("button", { name: copy.drawer })
    const bounds = await drawerTrigger.boundingBox()
    expect(bounds!.width).toBeGreaterThanOrEqual(44)
    expect(bounds!.height).toBeGreaterThanOrEqual(44)

    const identity = page.getByRole("group", {
      name: new RegExp(`Aster, Market brief, ${copy.status}`),
    })
    await expect(identity).toBeVisible()
    await expect(identity.locator('[data-agent-symbol="spark"]')).toBeVisible()

    await drawerTrigger.click()
    let drawer = page.getByRole("dialog", { name: copy.sessions })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole("heading", { name: "Aster" })).toBeFocused()
    await expect(
      drawer.getByRole("button", {
        name: new RegExp(`${copy.openSession}: Launch review`, "i"),
      })
    ).toBeVisible()
    await expect(
      drawer.locator('[data-thread-list-primitive="true"]').first()
    ).toBeVisible()

    await drawer.getByRole("button", { name: copy.backToAgents }).click()
    drawer = page.getByRole("dialog", { name: copy.agents })
    await expect(
      drawer.locator("[data-mobile-navigator-heading]")
    ).toBeFocused()
    await expect(drawer.getByRole("button", { name: /Mica/ })).toBeVisible()
    await drawer.getByRole("button", { name: /Aster/ }).click()
    drawer = page.getByRole("dialog", { name: copy.sessions })
    await expect(
      drawer.locator("[data-mobile-navigator-heading]")
    ).toBeFocused()
    await drawer
      .getByRole("button", {
        name: new RegExp(`${copy.openSession}: Launch review`, "i"),
      })
      .click()
    await expect(drawer).toHaveCount(0)
    await expect(
      page.getByRole("group", { name: new RegExp("Aster, Launch review") })
    ).toBeVisible()

    await drawerTrigger.click()
    drawer = page.getByRole("dialog", { name: copy.sessions })
    await drawer
      .getByRole("button", { name: `${copy.actions}: Market brief` })
      .click()
    await drawer.getByRole("menuitem", { name: copy.removeOpenSession }).click()
    await expect(drawer).toHaveCount(0)
    await expect(
      page.getByRole("status").filter({ hasText: copy.closed })
    ).toContainText("Market brief")
    await page.getByRole("button", { name: copy.undo, exact: true }).click()
    await expect(
      page.getByRole("group", { name: new RegExp("Aster, Launch review") })
    ).toBeVisible()

    await drawerTrigger.click()
    drawer = page.getByRole("dialog", { name: copy.sessions })
    await expect(
      drawer.getByRole("button", {
        name: new RegExp(`${copy.openSession}: Market brief`, "i"),
      })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(drawerTrigger).toBeFocused()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    return
  }

  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(page.getByRole("tablist", { name: copy.sessions })).toBeVisible()
  {
    const close = page.getByRole("button", {
      name:
        locale === "en"
          ? "Close session: Market brief"
          : "סגירת שיחה: Market brief",
    })
    await page.mouse.move(0, 0)
    await page.getByRole("tab", { name: "Market brief" }).hover()
    await expect(close).toBeVisible()
    await close.focus()
    await page.mouse.move(0, 0)
    await expect(close).toBeFocused()
  }
  // The workspace uses a named inline-size container. Account for the page's
  // outer padding so the container itself reaches the 64rem desktop layout.
  await page.setViewportSize({ width: 1056, height: 1000 })
  const actions = page.locator("[data-session-actions]")
  const newSession = actions.getByRole("button", { name: copy.newSession })
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const overflowing = await page
      .locator("[data-tab-viewport]")
      .evaluate((el) => el.scrollWidth > el.clientWidth)
    if (overflowing) break
    const tabCount = await page.getByRole("tab").count()
    await newSession.click()
    await expect(page.getByRole("tab")).toHaveCount(tabCount + 1)
  }
  expect(
    await page
      .locator("[data-tab-viewport]")
      .evaluate((el) => el.scrollWidth > el.clientWidth)
  ).toBe(true)
  await page.getByRole("tab", { name: "Market brief" }).click()
  await page.locator("[data-tab-viewport]").evaluate((el) => {
    el.scrollLeft = el.scrollWidth * (document.dir === "rtl" ? -1 : 1)
  })
  await expect(
    actions.getByRole("button", { name: copy.newSession })
  ).toBeVisible()
  await page
    .getByRole("button", { name: `${copy.actions}: Market brief` })
    .click()
  await expect(page.getByRole("menuitem", { name: copy.close })).toBeVisible()
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
  await expect(
    page.getByRole("button", { name: copy.undo, exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: copy.undo, exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
}
