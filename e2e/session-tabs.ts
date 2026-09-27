import { expect, type Page } from "./test"
import { longPress } from "./support/long-press"

const copy = {
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
  undo: "Undo",
  closed: "Tab closed",
} as const

export async function exerciseSessionTabs(page: Page, mobile: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/en")
  if (mobile) {
    await expect(
      page.getByRole("tablist", { name: copy.sessions })
    ).toBeHidden()
    const drawerTrigger = page.getByRole("button", { name: copy.drawer })

    const identity = page.getByRole("group", {
      name: new RegExp(`Aster, Market brief, ${copy.status}`),
    })
    await expect(identity).toBeVisible()

    await drawerTrigger.click()
    let drawer = page.getByRole("dialog", { name: copy.sessions })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole("heading", { name: "Aster" })).toBeFocused()
    await expect(
      drawer.getByRole("button", {
        name: new RegExp(`${copy.openSession}: Launch review`, "i"),
      })
    ).toBeVisible()

    await drawer.getByRole("button", { name: copy.backToAgents }).click()
    drawer = page.getByRole("dialog", { name: copy.agents })
    // The dialog's own title is also an "Agents" heading, so the check names
    // the focused element rather than picking one of the two.
    const focused = drawer.locator(":focus")
    await expect(focused).toHaveRole("heading")
    await expect(focused).toHaveAccessibleName(copy.agents)
    await expect(drawer.getByRole("button", { name: /Mica/ })).toBeVisible()
    await drawer.getByRole("button", { name: /Aster/ }).click()
    drawer = page.getByRole("dialog", { name: copy.sessions })
    await expect(drawer.getByRole("heading", { name: "Aster" })).toBeFocused()
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
    await longPress(
      page,
      drawer.getByRole("button", {
        name: new RegExp(`${copy.openSession}: Market brief`, "i"),
      })
    )
    // The row menu is portaled out of the drawer.
    await page.getByRole("menuitem", { name: copy.removeOpenSession }).click()
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
    return
  }

  // A read Session's tab is named by its title alone; an unread one appends
  // the unread marker through an explicit label.
  await expect(
    page.getByRole("tab", { name: "Market brief", exact: true })
  ).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tablist", { name: copy.sessions })).toBeVisible()
  {
    const close = page.getByRole("button", {
      name: "Close session: Market brief",
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
  const newSession = actions.getByRole("button", {
    name: copy.newSession,
    exact: true,
  })
  // Six more Sessions overflow the strip at this width.
  for (let created = 0; created < 6; created += 1) {
    const tabCount = await page.getByRole("tab").count()
    await newSession.click()
    await expect(page.getByRole("tab")).toHaveCount(tabCount + 1)
  }
  await page.getByRole("tab", { name: "Market brief" }).click()
  // The strip scrolls its last tab into reach while its actions stay in view.
  const lastTab = page.getByRole("tab").last()
  await lastTab.scrollIntoViewIfNeeded()
  await expect(lastTab).toBeInViewport()
  await expect(page.getByRole("tab").first()).not.toBeInViewport()
  await expect(newSession).toBeInViewport()
  // The inspector row for the same Session offers its own menu button, so the
  // tab strip's own overflow trigger has to be addressed inside the tab bar.
  await actions
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
  await actions
    .getByRole("button", { name: `${copy.actions}: Market brief` })
    .click()
  await page.getByRole("menuitem", { name: copy.close }).click()
  await expect(
    page.getByRole("button", { name: copy.undo, exact: true })
  ).toBeVisible()
}
