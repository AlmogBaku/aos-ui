import { expect, test } from "./test"
import {
  askHeading,
  background,
  deviceCheckbox,
  english,
  notificationCount,
  openSettings,
  permissionRequests,
  prepare,
  publish,
} from "./notifications"

test("the first watched turn offers the ask, and turning it on delivers one alert", async ({
  page,
}) => {
  await prepare(page)
  // Nothing is offered until the operator has watched an Agent work.
  await expect(askHeading(page)).toHaveCount(0)

  await page
    .getByRole("textbox", { name: english.messageInput })
    .fill("Summarize the next market signal")
  await page.getByRole("button", { name: english.sendMessage }).click()
  await expect(askHeading(page)).toBeVisible()

  await page
    .getByRole("button", { name: english.askAccept, exact: true })
    .click()
  await expect.poll(() => permissionRequests(page)).toBe(1)
  // The browser has answered, so the one-time offer is spent.
  await expect(askHeading(page)).toHaveCount(0)

  await openSettings(page)
  await expect(deviceCheckbox(page)).toBeChecked()
  await page.keyboard.press("Escape")

  await background(page, true)
  await publish(page, "question")
  await expect.poll(() => notificationCount(page)).toBe(1)
})

// Delivery follows the Session's own unread state, so the background arrival
// is Nori's, the Session the provider already reports unread.
test("hidden tab failure delivers private text and click opens the owning Agent/Session", async ({
  page,
}) => {
  await prepare(page, "granted")
  await background(page, true)
  await publish(page, "turn-failed")
  await expect.poll(() => notificationCount(page)).toBe(1)
  const notification = await page.evaluate(
    () => window.__notificationTest.notifications[0]
  )
  expect(notification.title).toBe("AOS")
  expect(notification.options.body).toBe("A turn failed")
  expect(JSON.stringify(notification)).not.toMatch(
    /Nori|Launch copy|thread-nori|agent-nori/
  )
  await page.evaluate(() =>
    window.__notificationTest.notifications[0].onclick?.()
  )
  await expect(page.getByRole("tab", { name: "Launch copy" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  expect(await page.evaluate(() => window.__notificationTest.focuses)).toBe(1)
  expect(
    await page.evaluate(() => window.__notificationTest.notifications[0].closed)
  ).toBe(true)
  // Opening the target is the read the provider records, so the count drops.
  await expect(
    page.getByRole("button", { name: "Activity, 1 unread", exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(page.getByRole("tablist")).toBeVisible()
  await page.getByRole("button", { name: english.activityBell }).click()
  // Only preferences persist: the browser keeps no activity across reloads,
  // so nothing is listed again and nothing is delivered again.
  await expect(
    page.getByRole("dialog").getByText("A turn failed", { exact: true })
  ).toHaveCount(0)
  expect(await notificationCount(page)).toBe(0)
  expect(await permissionRequests(page)).toBe(0)
})

test("denied notifications leave Activity usable without prompting", async ({
  page,
}) => {
  await prepare(page, "denied")
  await publish(page, "delayed-non-selected")
  await openSettings(page)
  await expect(deviceCheckbox(page)).toBeDisabled()
  await expect(
    page.getByRole("dialog").getByText("A turn finished", { exact: true })
  ).toBeVisible()
  expect(await permissionRequests(page)).toBe(0)
})
