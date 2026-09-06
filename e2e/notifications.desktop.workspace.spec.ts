import { expect, test, type Page } from "./test"
import type { FixtureActivityScenarioName } from "../lib/runtime-adapters/fixture/fixture-activity"

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

test("focused exact Session suppresses delivery; other Agent coalesces a notice and unread markers", async ({
  page,
}) => {
  await prepare(page)
  await enable(page)
  await publish(page, "run-completed")
  await expect(
    page.getByRole("button", { name: "Activity, 0 unread", exact: true })
  ).toBeVisible()
  await expect(page.locator("[data-activity-notice]")).toHaveCount(0)
  await publish(page, "delayed-non-selected")
  await publish(page, "duplicates")
  await expect(
    page.getByRole("button", { name: "Activity, 2 unread", exact: true })
  ).toBeVisible()
  await expect(page.locator("[data-activity-notice]")).toHaveCount(1)
  await expect(page.locator("[data-activity-notice]")).toContainText("(2)")
  await expect(
    page.getByRole("button", { name: /^Mica,.*1 unread/ })
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => window.__notificationTest.notifications.length)
    )
    .toBe(0)
})

for (const hidden of [true, false]) {
  test(`${hidden ? "hidden tab" : "visible unfocused window/app"} completion delivers private text and click opens the owning Agent/Session`, async ({
    page,
  }) => {
    await prepare(page)
    await enable(page)
    await background(page, hidden)
    await publish(page, "delayed-non-selected")
    await expect
      .poll(() =>
        page.evaluate(() => window.__notificationTest.notifications.length)
      )
      .toBe(1)
    const notification = await page.evaluate(
      () => window.__notificationTest.notifications[0]
    )
    expect(notification.title).toBe("AOS")
    expect(notification.options.body).toBe("A turn finished")
    expect(JSON.stringify(notification)).not.toMatch(
      /Mica|Quarterly|thread-mica|agent-mica/
    )
    await page.evaluate(() =>
      window.__notificationTest.notifications[0].onclick?.()
    )
    await expect(
      page.getByRole("tab", { name: "Quarterly synthesis" })
    ).toHaveAttribute("aria-selected", "true")
    expect(await page.evaluate(() => window.__notificationTest.focuses)).toBe(1)
    expect(
      await page.evaluate(
        () => window.__notificationTest.notifications[0].closed
      )
    ).toBe(true)
    await page.reload()
    await expect(page.getByRole("tablist")).toBeVisible()
    await page.getByRole("button", { name: /^Activity, / }).click()
    await expect(
      page.getByRole("dialog").getByText("A turn finished", { exact: true })
    ).toBeVisible()
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
  await expect(
    page.getByRole("button", { name: "Activity, 3 unread", exact: true })
  ).toBeVisible()
  await expect(
    page.locator("[data-activity-notice]").getByRole("alert")
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
  await publish(page, "delayed-non-selected")
  const notice = page.locator("[data-activity-notice]")
  await expect(notice).toBeVisible()
  await expect(notice).toHaveCSS("animation-name", "none")
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
