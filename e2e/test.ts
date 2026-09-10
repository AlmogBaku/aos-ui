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

function isTransientPreviewAssetError(message: string) {
  return (
    message.includes("net::ERR_NETWORK_CHANGED") ||
    (message.includes("Failed to fetch dynamically imported module") &&
      message.includes("127.0.0.1"))
  )
}

function watchBrowserErrors(page: Page) {
  const errors: string[] = []

  page.on("console", (message) => {
    const error = describeConsoleError(message)
    if (message.type() === "error" && !isTransientPreviewAssetError(error)) {
      errors.push(error)
    }
  })
  page.on("pageerror", (error) => {
    const message = error.stack ?? error.message
    if (!isTransientPreviewAssetError(message)) errors.push(message)
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
