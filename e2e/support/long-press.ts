import type { Locator } from "@playwright/test"

import { expect, type Page } from "../test"

/**
 * Chromium never promotes a synthetic tap to a long press, so the press is
 * dispatched through CDP. A recognized long press hands the touch to the
 * context menu and the page receives `touchcancel`; a synthetic `touchEnd`
 * would instead deliver the tap the platform suppresses.
 */
export async function pressAndHold(
  page: Page,
  target: Locator,
  whileHeld: () => Promise<void>
) {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  const session = await page.context().newCDPSession(page)
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }],
  })
  await whileHeld()
  await session.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  })
  await session.detach()
}

/** A long press opens the menu its target owns. */
export async function longPress(page: Page, target: Locator) {
  await pressAndHold(page, target, () =>
    expect(page.getByRole("menu")).toBeVisible()
  )
}
