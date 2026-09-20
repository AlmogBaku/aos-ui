import { expect, test, type Page } from "./test"
import type { Locator } from "@playwright/test"
import {
  askHeading,
  english,
  notificationCount,
  prepare,
  startSelectedRun,
} from "./notifications"

/** Walks the real tab order until the control takes focus. */
async function tabTo(page: Page, locator: Locator, limit = 60) {
  for (let presses = 1; presses <= limit; presses++) {
    await page.keyboard.press("Tab")
    const focused = await locator.evaluate(
      (element) => element === document.activeElement
    )
    if (focused) return presses
  }
  throw new Error(`The control was not reachable within ${limit} Tab presses`)
}

test("the ask arrives on a phone and both answers are reachable by keyboard", async ({
  page,
}) => {
  await prepare(page)
  await startSelectedRun(page)

  await expect(askHeading(page)).toBeVisible()
  const accept = page.getByRole("button", {
    name: english.askAccept,
    exact: true,
  })
  const decline = page.getByRole("button", {
    name: english.askDecline,
    exact: true,
  })
  await expect(accept).toBeVisible()
  await expect(decline).toBeVisible()

  await tabTo(page, accept)
  await expect(accept).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(decline).toBeFocused()

  await page.keyboard.press("Enter")
  await expect(askHeading(page)).toHaveCount(0)
  // Declining answers the browser's question without ever asking the OS.
  expect(await notificationCount(page)).toBe(0)
})
