import type { Locator } from "@playwright/test"

import { expect, type Page } from "./test"

type SessionActionsCopy = {
  sessions: string
  agents: string
  openAgents: string
  backToAgents: string
  agentDetails: string
  openSessions: string
  history: string
  archived: string
  openSession: string
  actions: string
  rename: string
  pin: string
  archive: string
  unarchive: string
  closeTab: string
  delete: string
  renameTitle: string
  sessionTitle: string
  save: string
  cancel: string
  deleteTitle: string
  deleteConfirm: string
  pinned: string
  selected: string
}

const english: SessionActionsCopy = {
  sessions: "Sessions",
  agents: "Agents",
  openAgents: "Open Agents",
  backToAgents: "Back to Agents",
  agentDetails: "Agent details",
  openSessions: "Open sessions",
  history: "History",
  archived: "Archived",
  openSession: "Open session",
  actions: "Session actions",
  rename: "Rename",
  pin: "Pin",
  archive: "Archive",
  unarchive: "Unarchive",
  closeTab: "Close tab",
  delete: "Delete",
  renameTitle: "Rename Session",
  sessionTitle: "Session title",
  save: "Save",
  cancel: "Cancel",
  deleteTitle: "Delete this Session?",
  deleteConfirm: "Delete Session",
  pinned: "Pinned",
  selected: "Current Session",
}

const hebrew: SessionActionsCopy = {
  sessions: "שיחות",
  agents: "סוכנים",
  openAgents: "פתיחת רשימת הסוכנים",
  backToAgents: "חזרה לסוכנים",
  agentDetails: "פרטי הסוכן",
  openSessions: "שיחות פתוחות",
  history: "היסטוריה",
  archived: "ארכיון",
  openSession: "פתיחת שיחה",
  actions: "פעולות שיחה",
  rename: "שינוי שם",
  pin: "הצמדה",
  archive: "העברה לארכיון",
  unarchive: "הוצאה מהארכיון",
  closeTab: "סגירת לשונית",
  delete: "מחיקה",
  renameTitle: "שינוי שם השיחה",
  sessionTitle: "שם השיחה",
  save: "שמירה",
  cancel: "ביטול",
  deleteTitle: "למחוק את השיחה?",
  deleteConfirm: "מחיקת השיחה",
  pinned: "מוצמדת",
  selected: "השיחה הנוכחית",
}

/** Rows append status, selection, and state to their Session title. */
function rowName(copy: SessionActionsCopy, title: string) {
  return new RegExp(`^${copy.openSession}: ${title}(?:,|$)`, "i")
}

function rows(scope: Locator, copy: SessionActionsCopy) {
  return scope.getByRole("button", {
    name: new RegExp(`^${copy.openSession}: `, "i"),
  })
}

function menuItem(page: Page, name: string) {
  return page.getByRole("menuitem", { name, exact: true })
}

function rowMenu(scope: Locator, copy: SessionActionsCopy, title: string) {
  return scope.getByRole("button", {
    name: `${copy.actions}: ${title}`,
    exact: true,
  })
}

async function renameThroughDialog(
  page: Page,
  copy: SessionActionsCopy,
  currentTitle: string,
  nextTitle: string
) {
  const dialog = page.getByRole("dialog", { name: copy.renameTitle })
  const title = dialog.getByRole("textbox", { name: copy.sessionTitle })
  await expect(title).toHaveValue(currentTitle)
  await expect(title).toBeFocused()
  await expect(dialog.getByRole("button", { name: copy.cancel })).toBeVisible()
  await expect(dialog.getByRole("button", { name: copy.save })).toBeVisible()
  // The prefilled title arrives selected, so typing replaces all of it.
  await page.keyboard.type(nextTitle)
  await page.keyboard.press("Enter")
  await expect(dialog).toHaveCount(0)
}

/**
 * Chromium never promotes a synthetic tap to a long press, so the press is
 * dispatched through CDP. A recognized long press hands the touch to the
 * context menu and the page receives `touchcancel`; a synthetic `touchEnd`
 * would instead deliver the tap the platform suppresses.
 */
async function longPress(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  const session = await page.context().newCDPSession(page)
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }],
  })
  await expect(page.getByRole("menu")).toBeVisible()
  await session.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  })
  await session.detach()
}

async function exerciseDesktop(page: Page, copy: SessionActionsCopy) {
  const inspector = page.getByRole("complementary", { name: copy.agentDetails })
  const openSessions = inspector.getByRole("region", {
    name: copy.openSessions,
  })
  const history = inspector.getByRole("region", { name: copy.history })
  const archived = inspector.getByRole("region", { name: copy.archived })
  const tabActions = page.locator("[data-session-actions]")
  const tab = (title: string) =>
    page.getByRole("tab", { name: title, exact: true })

  // A right click on a background tab offers the same items as its row.
  await tab("Launch review").click({ button: "right" })
  for (const item of [
    copy.rename,
    copy.pin,
    copy.archive,
    copy.closeTab,
    copy.delete,
  ]) {
    await expect(menuItem(page, item)).toBeVisible()
  }
  await menuItem(page, copy.rename).click()
  await renameThroughDialog(page, copy, "Launch review", "Launch review 2")
  await expect(tab("Launch review")).toHaveCount(0)
  await expect(tab("Launch review 2")).toBeVisible()
  await expect(
    openSessions.getByRole("button", { name: rowName(copy, "Launch review 2") })
  ).toBeVisible()

  // Pinning a History row floats it to the top of its own section.
  await rowMenu(history, copy, "Customer interviews").click()
  await menuItem(page, copy.pin).click()
  await expect(rows(history, copy).first()).toHaveAccessibleName(
    new RegExp(`Customer interviews, ${copy.pinned}$`)
  )

  // Archiving an open Session closes its tab and keeps the selection put.
  await tab("Competitive scan").click({ button: "right" })
  await menuItem(page, copy.archive).click()
  await expect(tab("Competitive scan")).toHaveCount(0)
  await expect(tab("Market brief")).toHaveAttribute("aria-selected", "true")
  await expect(archived).toBeVisible()
  const archivedRow = archived.getByText("Competitive scan", { exact: true })
  await expect(archivedRow).toBeHidden()
  await archived.getByRole("heading", { name: copy.archived }).click()
  await expect(archivedRow).toBeVisible()
  await rowMenu(archived, copy, "Competitive scan").click()
  await expect(menuItem(page, copy.unarchive)).toBeVisible()
  await menuItem(page, copy.unarchive).click()
  await expect(archived).toHaveCount(0)
  // The Session is recent enough to be active again, so it reopens its tab.
  await expect(
    openSessions.getByRole("button", {
      name: rowName(copy, "Competitive scan"),
    })
  ).toBeVisible()
  await expect(tab("Competitive scan")).toBeVisible()

  // Deleting asks first, and only the confirmation removes the Session.
  const pricing = history.getByRole("button", {
    name: rowName(copy, "Pricing analysis"),
  })
  await rowMenu(history, copy, "Pricing analysis").click()
  await menuItem(page, copy.delete).click()
  const confirm = page.getByRole("alertdialog", { name: copy.deleteTitle })
  await expect(confirm).toContainText("Pricing analysis")
  await confirm.getByRole("button", { name: copy.cancel }).click()
  await expect(confirm).toHaveCount(0)
  await expect(pricing).toBeVisible()
  await rowMenu(history, copy, "Pricing analysis").click()
  await menuItem(page, copy.delete).click()
  await confirm.getByRole("button", { name: copy.deleteConfirm }).click()
  await expect(pricing).toHaveCount(0)

  // Archiving the active Session hands the selection to its neighbor without
  // opening a replacement draft.
  await rowMenu(tabActions, copy, "Market brief").click()
  await menuItem(page, copy.archive).click()
  await expect(tab("Market brief")).toHaveCount(0)
  await expect(tab("Launch review 2")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tab")).toHaveCount(2)
}

async function exerciseMobile(page: Page, copy: SessionActionsCopy) {
  const drawer = page.getByRole("dialog", { name: copy.sessions })
  const openSessions = drawer.getByRole("region", { name: copy.openSessions })
  const history = drawer.getByRole("region", { name: copy.history })
  const archived = drawer.getByRole("region", { name: copy.archived })

  await page.getByRole("button", { name: copy.openAgents }).click()
  await expect(drawer).toBeVisible()

  await rowMenu(openSessions, copy, "Launch review").click()
  await menuItem(page, copy.rename).click()
  await renameThroughDialog(page, copy, "Launch review", "Launch review 2")
  await expect(
    openSessions.getByRole("button", { name: rowName(copy, "Launch review 2") })
  ).toBeVisible()

  // A long press opens the row menu instead of opening the Session.
  await longPress(
    page,
    history.getByRole("button", { name: rowName(copy, "Customer interviews") })
  )
  await menuItem(page, copy.pin).click()
  await expect(drawer).toBeVisible()
  await expect(
    openSessions.getByRole("button", { name: rowName(copy, "Market brief") })
  ).toHaveAccessibleName(new RegExp(`${copy.selected}$`))
  await expect(
    history.getByRole("button", { name: rowName(copy, "Customer interviews") })
  ).toHaveAccessibleName(new RegExp(`Customer interviews, ${copy.pinned}$`))

  // Another Agent keeps its archived Sessions behind the same disclosure.
  await drawer.getByRole("button", { name: copy.backToAgents }).click()
  await page
    .getByRole("dialog", { name: copy.agents })
    .getByRole("button", { name: /^Vela/ })
    .click()
  await expect(archived).toBeVisible()
  const archivedRow = archived.getByText("Campaign retrospective", {
    exact: true,
  })
  await expect(archivedRow).toBeHidden()
  await archived.getByRole("heading", { name: copy.archived }).click()
  await expect(archivedRow).toBeVisible()
  await rowMenu(archived, copy, "Campaign retrospective").click()
  await expect(menuItem(page, copy.unarchive)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toHaveCount(0)

  // Returning to the Agent rebuilds its order, so the pinned row leads.
  await drawer.getByRole("button", { name: copy.backToAgents }).click()
  await page
    .getByRole("dialog", { name: copy.agents })
    .getByRole("button", { name: /^Aster/ })
    .click()
  await expect(rows(history, copy).first()).toHaveAccessibleName(
    new RegExp(`Customer interviews, ${copy.pinned}$`)
  )
}

export async function exerciseSessionActions(
  page: Page,
  mobile: boolean,
  locale: "en" | "he"
) {
  const copy = locale === "en" ? english : hebrew
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`/${locale}`)
  if (mobile) await exerciseMobile(page, copy)
  else await exerciseDesktop(page, copy)
}
