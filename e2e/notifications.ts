import { expect, type Page } from "./test"

/**
 * Taken from the fixture workspace the preview exposes, so the scenario names
 * stay checked without reaching into the provider package.
 */
type FixtureActivityScenarioName = Parameters<
  NonNullable<Window["__AOS_UI_FIXTURE_WORKSPACE__"]>["publishActivityScenario"]
>[0]

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

type MockPermission = NotificationPermission | "unsupported"

/** Accessible names the notification journeys depend on. */
export const english = {
  activityBell: /^Activity, /,
  askTitle: "Get told when Agents finish or need you",
  askAccept: "Turn on",
  settings: "Notification settings",
  device: "Notifications on this device",
  messageInput: "Message input",
  sendMessage: "Send message",
} as const

/**
 * Replaces the OS notification surface, page visibility and focus with a
 * readable record, so the journeys can observe what the operator would get.
 * The script is reinstalled on every navigation, so a reload restores the
 * starting permission while stored preferences stay the operator's own.
 */
async function installNotificationMock(
  page: Page,
  permission: MockPermission = "default"
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
}

/** The Activity bell is the one control both layouts always render. */
async function openWorkspace(page: Page) {
  await page.goto("/en")
  await expect(
    page.getByRole("button", { name: english.activityBell })
  ).toBeVisible()
  await page.waitForFunction(() => Boolean(window.__AOS_UI_FIXTURE_WORKSPACE__))
}

export async function prepare(
  page: Page,
  permission: MockPermission = "default"
) {
  await installNotificationMock(page, permission)
  await openWorkspace(page)
}

export async function publish(
  page: Page,
  scenario: FixtureActivityScenarioName
) {
  await page.evaluate(
    (scenario) =>
      window.__AOS_UI_FIXTURE_WORKSPACE__!.publishActivityScenario(scenario),
    scenario
  )
}

/** Leaves the window unfocused, hidden or merely covered by another app. */
export async function background(page: Page, hidden: boolean) {
  await page.evaluate((hidden) => {
    window.__notificationTest.visible = !hidden
    window.__notificationTest.focused = false
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("blur"))
  }, hidden)
}

export function notificationCount(page: Page) {
  return page.evaluate(() => window.__notificationTest.notifications.length)
}

export function permissionRequests(page: Page) {
  return page.evaluate(() => window.__notificationTest.requests)
}

/** Opens the Activity drawer and expands the notification settings inside it. */
export async function openSettings(page: Page) {
  await page.getByRole("button", { name: english.activityBell }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  const summary = page.getByText(english.settings, { exact: true })
  await summary.click()
  return page.getByRole("dialog")
}

export function deviceCheckbox(page: Page) {
  return page.getByRole("checkbox", {
    name: english.device,
    exact: true,
  })
}

export function askHeading(page: Page) {
  return page.getByRole("heading", {
    name: english.askTitle,
    exact: true,
  })
}
