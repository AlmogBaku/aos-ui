import { expect, test, type Page } from "./test"
import type { FixtureActivityScenarioName } from "../src/runtime-adapters/fixture/fixture-activity"

declare global {
  interface Window {
    __notificationTest: {
      visible: boolean
      focused: boolean
      requests: number
      focuses: number
      notifications: {
        title: string
        options: NotificationOptions
        onclick?: () => void
        closed: boolean
      }[]
    }
  }
}

async function prepare(
  page: Page,
  permission: NotificationPermission | "unsupported" = "default"
) {
  await page.addInitScript((permission) => {
    const state = (window.__notificationTest = {
      visible: true,
      focused: true,
      requests: 0,
      focuses: 0,
      notifications: [],
    })
    Object.defineProperty(document, "visibilityState", {
      get: () => (state.visible ? "visible" : "hidden"),
    })
    document.hasFocus = () => state.focused
    window.focus = () => {
      state.focuses++
    }
    class MockNotification {
      static permission = permission
      static async requestPermission() {
        state.requests++
        this.permission = "granted"
        return "granted"
      }
      closed = false
      onclick?: () => void
      constructor(
        public title: string,
        public options: NotificationOptions
      ) {
        window.__notificationTest.notifications.push(this)
      }
      close() {
        this.closed = true
      }
    }
    Object.defineProperty(window, "Notification", {
      value: permission === "unsupported" ? undefined : MockNotification,
      configurable: true,
    })
  }, permission)
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeVisible()
  await page.waitForFunction(() => Boolean(window.__AOS_UI_FIXTURE_WORKSPACE__))
}

async function publish(page: Page, scenario: FixtureActivityScenarioName) {
  await page.evaluate(
    (scenario) =>
      window.__AOS_UI_FIXTURE_WORKSPACE__!.publishActivityScenario(scenario),
    scenario
  )
}

async function background(page: Page, hidden: boolean) {
  await page.evaluate((hidden) => {
    window.__notificationTest.visible = !hidden
    window.__notificationTest.focused = false
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("blur"))
  }, hidden)
}

async function enable(page: Page) {
  await page.getByRole("button", { name: /^Activity, / }).click()
  await page.getByText("Notification settings", { exact: true }).click()
  await page
    .getByRole("checkbox", { name: "Browser notifications", exact: true })
    .check()
  await expect
    .poll(() => page.evaluate(() => window.__notificationTest.requests))
    .toBe(1)
  await page.keyboard.press("Escape")
}

test("the Activity count follows Session state, and arrivals on read Sessions stay silent", async ({
  page,
}) => {
  await prepare(page)
  await enable(page)
  // The provider reports two unread Sessions: Lumen's and Nori's.
  const bell = (count: number) =>
    page.getByRole("button", {
      name: `Activity, ${count} unread`,
      exact: true,
    })
  await expect(bell(2)).toBeVisible()

  await publish(page, "run-completed")
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
  await page.getByRole("button", { name: /^Activity, / }).click()
  await expect(
    page.getByRole("dialog").getByText("A turn finished", { exact: true })
  ).toHaveCount(3)
  await expect
    .poll(() =>
      page.evaluate(() => window.__notificationTest.notifications.length)
    )
    .toBe(0)
})

for (const hidden of [true, false]) {
  // Delivery follows the Session's own unread state, so the background arrival
  // is Nori's, the Session the provider already reports unread.
  test(`${hidden ? "hidden tab" : "visible unfocused window/app"} failure delivers private text and click opens the owning Agent/Session`, async ({
    page,
  }) => {
    await prepare(page)
    await enable(page)
    await background(page, hidden)
    await publish(page, "run-failed")
    await expect
      .poll(() =>
        page.evaluate(() => window.__notificationTest.notifications.length)
      )
      .toBe(1)
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
    await page.getByRole("button", { name: /^Activity, / }).click()
    // Only preferences persist: the browser keeps no activity across reloads,
    // so nothing is listed again and nothing is delivered again.
    await expect(
      page.getByRole("dialog").getByText("A turn failed", { exact: true })
    ).toHaveCount(0)
    expect(
      await page.evaluate(() => window.__notificationTest.notifications.length)
    ).toBe(0)
    expect(await page.evaluate(() => window.__notificationTest.requests)).toBe(
      0
    )
  })
}

test("question, permission and failure remain inspectable; stale arrivals do not navigate", async ({
  page,
}) => {
  await prepare(page)
  await publish(page, "question")
  await publish(page, "permission")
  await publish(page, "run-failed")
  await publish(page, "stale-target")
  // Arrivals do not raise the count: it is the unread and waiting Sessions.
  await expect(
    page.getByRole("button", { name: "Activity, 2 unread", exact: true })
  ).toBeVisible()
  await expect(
    page.locator('[data-activity-notice="true"]').getByRole("alert")
  ).toBeVisible()
  await page.getByRole("button", { name: /^Activity, / }).click()
  await expect(
    page
      .getByRole("dialog")
      .getByText("Your Agent needs input", { exact: true })
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
    await page.getByRole("button", { name: /^Activity, / }).click()
    await page.getByText("Notification settings", { exact: true }).click()
    await expect(
      page.getByRole("checkbox", { name: "Browser notifications", exact: true })
    ).toBeDisabled()
    await expect(
      page.getByRole("dialog").getByText("A turn finished", { exact: true })
    ).toBeVisible()
    expect(await page.evaluate(() => window.__notificationTest.requests)).toBe(
      0
    )
  })
}

test("Activity drawer restores focus, makes background inert and honors reduced motion in Hebrew mobile layout", async ({
  page,
}) => {
  await prepare(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/he")
  await page.waitForFunction(() => Boolean(window.__AOS_UI_FIXTURE_WORKSPACE__))
  // An unread Session's arrival is the one that raises an in-app notice.
  await publish(page, "question")
  const notice = page.locator('[data-activity-notice="true"]')
  await expect(notice).toBeVisible()
  const bell = page.getByRole("button", { name: /^פעילות, / })
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
