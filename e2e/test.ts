import {
  expect,
  test as base,
  type ConsoleMessage,
  type Locator,
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
      message.includes("127.0.0.1")) ||
    // pdf.js emits diagnostic warnings for unsupported or legacy PDF constructs
    // that do not prevent rendering.
    message.includes("Warning: Unsupported") ||
    message.includes("pdf.js") ||
    message.includes("PDF.js") ||
    // The artifact view's HTML preview intentionally renders Agent HTML inside
    // `<iframe sandbox="">` with no `allow-scripts`; Chrome reports each
    // blocked script as a console error, which is the expected behavior.
    message.includes("Blocked script execution in 'about:srcdoc'")
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
export type { Locator, Page }
