import { expect, test } from "./test"
import {
  askHeading,
  background,
  deviceCheckbox,
  english,
  foreground,
  hebrew,
  installNotificationMock,
  notificationCount,
  openSettings,
  openWorkspace,
  permissionRequests,
  prepare,
  publish,
  startSelectedRun,
} from "./notifications"

test("the first watched run offers the ask, and turning it on delivers one alert", async ({
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

test("declining the ask keeps this device quiet, and the refusal survives a reload", async ({
  page,
}) => {
  await prepare(page)
  await startSelectedRun(page)
  await expect(askHeading(page)).toBeVisible()

  await page
    .getByRole("button", { name: english.askDecline, exact: true })
    .click()
  await expect(askHeading(page)).toHaveCount(0)
  expect(await permissionRequests(page)).toBe(0)

  await openWorkspace(page)
  // Another watched run does not reopen a question the operator answered.
  await startSelectedRun(page)
  await expect(askHeading(page)).toHaveCount(0)
  await openSettings(page)
  await expect(deviceCheckbox(page)).not.toBeChecked()
  await page.keyboard.press("Escape")

  await background(page, true)
  await publish(page, "question")
  // Delivery settles well inside this window, so nothing is left waiting.
  await page.waitForTimeout(600)
  await foreground(page)
  await page.getByRole("button", { name: english.activityBell }).click()
  await expect(
    page.getByRole("dialog").getByText(english.inputRequested, { exact: true })
  ).toBeVisible()
  expect(await notificationCount(page)).toBe(0)
})

test("the chime stays off once the operator turns it off", async ({ page }) => {
  await prepare(page)
  const sound = page.getByRole("checkbox", {
    name: english.sound,
    exact: true,
  })
  await openSettings(page)
  await expect(sound).toBeChecked()
  await sound.uncheck()
  await expect(sound).not.toBeChecked()

  await openWorkspace(page)
  await openSettings(page)
  await expect(sound).not.toBeChecked()
})

for (const locale of ["en", "he"] as const) {
  const copy = locale === "he" ? hebrew : english
  test(`settings say what reaches this device while AOS is closed in ${locale}`, async ({
    page,
  }) => {
    await prepare(page, "default", locale)
    const dialog = await openSettings(page, locale)
    await expect(
      dialog.getByRole("status").filter({ hasText: copy.whenClosed })
    ).toHaveText(`${copy.whenClosed}: ${copy.pushNotConfigured}`)
  })
}

test("a device that already granted permission is on without ever being asked", async ({
  page,
}) => {
  await prepare(page, "granted")
  await startSelectedRun(page)
  // Permission is settled, so the ask has nothing to offer.
  await expect(askHeading(page)).toHaveCount(0)
  await openSettings(page)
  await expect(deviceCheckbox(page)).toBeChecked()
  await page.keyboard.press("Escape")

  await background(page, true)
  await publish(page, "question")
  await expect.poll(() => notificationCount(page)).toBe(1)
  expect(await permissionRequests(page)).toBe(0)
})

test("the Activity count follows Session state, and arrivals on read Sessions stay silent", async ({
  page,
}) => {
  await prepare(page, "granted")
  // The provider reports two unread Sessions: Lumen's and Nori's.
  const bell = (count: number) =>
    page.getByRole("button", {
      name: `Activity, ${count} unread`,
      exact: true,
    })
  await expect(bell(2)).toBeVisible()

  await publish(page, "turn-completed")
  await publish(page, "delayed-non-selected")
  await publish(page, "duplicates")

  // None of those three Sessions is unread, so nothing is counted or announced.
  await expect(bell(2)).toBeVisible()
  await expect(page.locator('[data-activity-notice="true"]')).toHaveCount(0)

  // Navigation marks the Agents holding unread Sessions, not the ones that ran.
  const agents = page.getByRole("navigation", { name: "Agents" })
  await expect(agents.getByRole("button", { name: /^Lumen/ })).toHaveAttribute(
    "aria-label",
    "Lumen, Status: Needs attention, Unread"
  )
  await expect(agents.getByRole("button", { name: /^Nori/ })).toHaveAttribute(
    "aria-label",
    "Nori, Unread"
  )
  await expect(agents.getByRole("button", { name: /^Mica/ })).toHaveAttribute(
    "aria-label",
    "Mica"
  )

  // Every arrival stays inspectable in the drawer, read or not.
  await page.getByRole("button", { name: english.activityBell }).click()
  await expect(
    page.getByRole("dialog").getByText("A turn finished", { exact: true })
  ).toHaveCount(3)
  await expect.poll(() => notificationCount(page)).toBe(0)
})

for (const hidden of [true, false]) {
  // Delivery follows the Session's own unread state, so the background arrival
  // is Nori's, the Session the provider already reports unread.
  test(`${hidden ? "hidden tab" : "visible unfocused window/app"} failure delivers private text and click opens the owning Agent/Session`, async ({
    page,
  }) => {
    await prepare(page, "granted")
    await background(page, hidden)
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
    await expect(
      page.getByRole("tab", { name: "Launch copy" })
    ).toHaveAttribute("aria-selected", "true")
    expect(await page.evaluate(() => window.__notificationTest.focuses)).toBe(1)
    expect(
      await page.evaluate(
        () => window.__notificationTest.notifications[0].closed
      )
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
}

test("question, permission and failure remain inspectable; stale arrivals do not navigate", async ({
  page,
}) => {
  await prepare(page)
  await publish(page, "question")
  await publish(page, "permission")
  await publish(page, "turn-failed")
  await publish(page, "stale-target")
  // Arrivals do not raise the count: it is the unread and waiting Sessions.
  await expect(
    page.getByRole("button", { name: "Activity, 2 unread", exact: true })
  ).toBeVisible()
  await expect(
    page.locator('[data-activity-notice="true"]').getByRole("alert")
  ).toBeVisible()
  await page.getByRole("button", { name: english.activityBell }).click()
  await expect(
    page.getByRole("dialog").getByText(english.inputRequested, { exact: true })
  ).toHaveCount(2)
  await expect(
    page.getByRole("dialog").getByText("A turn failed", { exact: true })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
})

for (const permission of ["denied", "unsupported"] as const) {
  test(`${permission} notifications leave Activity usable without prompting`, async ({
    page,
  }) => {
    await prepare(page, permission)
    await publish(page, "delayed-non-selected")
    await openSettings(page)
    await expect(deviceCheckbox(page)).toBeDisabled()
    await expect(
      page.getByRole("dialog").getByText("A turn finished", { exact: true })
    ).toBeVisible()
    expect(await permissionRequests(page)).toBe(0)
  })
}

test("Activity drawer restores focus, makes background inert and honors reduced motion in Hebrew mobile layout", async ({
  page,
}) => {
  await installNotificationMock(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await openWorkspace(page, "he")
  // An unread Session's arrival is the one that raises an in-app notice.
  await publish(page, "question")
  const notice = page.locator('[data-activity-notice="true"]')
  await expect(notice).toBeVisible()
  const bell = page.getByRole("button", { name: hebrew.activityBell })
  await expect(bell).toBeVisible()
  await bell.click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  expect(await page.locator("[inert]").count()).toBeGreaterThan(0)
  await page.keyboard.press("Tab")
  expect(
    await page
      .getByRole("dialog")
      .evaluate((dialog) => dialog.contains(document.activeElement))
  ).toBe(true)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(bell).toBeFocused()
})
