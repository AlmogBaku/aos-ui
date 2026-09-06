import {
  expect,
  test as base,
  type ConsoleMessage,
  type Page,
} from "@playwright/test"

type BrowserErrorGuard = {
  assertNoBrowserErrors: void
}

function describeConsoleError(message: ConsoleMessage) {
  const location = message.location()
  const source = location.url
    ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})`
    : ""
  return `${message.text()}${source}`
}

function watchBrowserErrors(page: Page) {
  const errors: string[] = []

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(describeConsoleError(message))
  })
  page.on("pageerror", (error) => {
    errors.push(error.stack ?? error.message)
  })

  return errors
}

export const test = base.extend<BrowserErrorGuard>({
  assertNoBrowserErrors: [
    async ({ page }, use) => {
      const errors = watchBrowserErrors(page)
      await use()
      expect(errors, "unexpected browser errors").toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
export type { Page }
