import { expect, type Page } from "./test"
import { longPress, pressAndHold } from "./support/long-press"

type MessageActionsCopy = {
  copy: string
  retry: string
  exportMarkdown: string
  edit: string
  selectText: string
  update: string
  cancel: string
}

const english: MessageActionsCopy = {
  copy: "Copy",
  retry: "Retry response",
  exportMarkdown: "Export as Markdown",
  edit: "Edit message",
  selectText: "Select text",
  update: "Update",
  cancel: "Cancel",
}

const hebrew: MessageActionsCopy = {
  copy: "העתקה",
  retry: "ניסיון חוזר",
  exportMarkdown: "ייצוא כ-Markdown",
  edit: "עריכת ההודעה",
  selectText: "בחירת טקסט",
  update: "עדכון",
  cancel: "ביטול",
}

/** The fixture turns, located by the text a reader sees in either locale. */
const USER_TURN = /^Prepare my Q1 planning brief/
const ASSISTANT_TURN =
  /^Applied AI is accelerating fastest in the planning dataset/

function turn(page: Page, text: RegExp) {
  return page.getByText(text).first()
}

function menuItem(page: Page, name: string) {
  return page.getByRole("menuitem", { name, exact: true })
}

/**
 * The menu opens on the `contextmenu` or long-press event itself, so two frames
 * later a menu that was going to open already exists.
 */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

/** Editing replaces the turn with a composer that updates it or backs out. */
async function cancelEditComposer(page: Page, copy: MessageActionsCopy) {
  const cancel = page.getByRole("button", { name: copy.cancel, exact: true })
  await expect(
    page.getByRole("button", { name: copy.update, exact: true })
  ).toBeVisible()
  await expect(cancel).toBeVisible()
  await cancel.click()
  await expect(turn(page, USER_TURN)).toBeVisible()
}

async function exerciseDesktop(page: Page, copy: MessageActionsCopy) {
  const menu = page.getByRole("menu")
  const assistant = turn(page, ASSISTANT_TURN)

  // A right click offers the actions the assistant action bar holds. A pointer
  // can reach that bar, so this menu adds no selection item.
  await assistant.click({ button: "right" })
  await expect(menu).toBeVisible()
  for (const item of [copy.copy, copy.retry, copy.exportMarkdown])
    await expect(menuItem(page, item)).toBeVisible()
  await expect(menuItem(page, copy.edit)).toHaveCount(0)
  await expect(menuItem(page, copy.selectText)).toHaveCount(0)
  await menuItem(page, copy.copy).click()
  await expect(menu).toHaveCount(0)

  // A user turn is editable instead of retryable, and Edit opens its composer.
  await turn(page, USER_TURN).click({ button: "right" })
  await expect(menuItem(page, copy.copy)).toBeVisible()
  await expect(menuItem(page, copy.retry)).toHaveCount(0)
  await menuItem(page, copy.edit).click()
  await expect(menu).toHaveCount(0)
  await cancelEditComposer(page, copy)

  // A selection a reader already made belongs to the browser's own menu, which
  // Playwright cannot observe; the honest assertion is that ours stays shut.
  // The same press opened our menu above, so only the selection can stop it.
  await assistant.evaluate((element) => {
    const owner = element.ownerDocument
    const range = owner.createRange()
    range.selectNodeContents(element.firstChild ?? element)
    const selection = owner.defaultView?.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await assistant.click({ button: "right" })
  expect(await page.evaluate(() => getSelection()?.isCollapsed)).toBe(false)
  await settle(page)
  await expect(menu).toHaveCount(0)
}

async function exerciseMobile(page: Page, copy: MessageActionsCopy) {
  const menu = page.getByRole("menu")
  const assistant = turn(page, ASSISTANT_TURN)

  // Touch is the only pointer here, so a long press is the way into the actions
  // and every message also offers the reader its text back.
  await longPress(page, turn(page, USER_TURN))
  await expect(menuItem(page, copy.copy)).toBeVisible()
  await menuItem(page, copy.edit).click()
  await expect(menu).toHaveCount(0)
  await cancelEditComposer(page, copy)

  await longPress(page, assistant)
  await expect(menuItem(page, copy.selectText)).toBeVisible()
  await menuItem(page, copy.selectText).click()
  await expect(menu).toHaveCount(0)

  // The next press on this message is the browser's to interpret, not ours.
  await pressAndHold(page, assistant, async () => {
    await settle(page)
    await expect(menu).toHaveCount(0)
  })
}

export async function exerciseMessageActions(
  page: Page,
  mobile: boolean,
  locale: "en" | "he"
) {
  const copy = locale === "en" ? english : hebrew
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`/${locale}`)
  await expect(turn(page, ASSISTANT_TURN)).toBeVisible()
  if (mobile) await exerciseMobile(page, copy)
  else await exerciseDesktop(page, copy)
}
