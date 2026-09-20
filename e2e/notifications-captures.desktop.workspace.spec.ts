import { expect, test, type Page } from "./test"
import {
  askHeading,
  english,
  hebrew,
  openSettings,
  prepare,
  startSelectedRun,
} from "./notifications"

/**
 * Screenshots for the design pass. These captures assert nothing about the
 * product: every expectation here only waits for the surface to settle before
 * the shutter. They stay out of ordinary runs unless AOS_UI_CAPTURE=1 asks for
 * a refresh.
 */
const directory = "/tmp/aos-notifications-captures"

/** The shell follows the device, so a dark capture only emulates the device. */
async function capture(
  page: Page,
  {
    file,
    locale = "en",
    dark = false,
  }: {
    file: string
    locale?: "en" | "he"
    dark?: boolean
  }
) {
  if (dark) await page.emulateMedia({ colorScheme: "dark" })
  await prepare(page, "default", locale)
  await startSelectedRun(page)
  await expect(askHeading(page, locale)).toBeVisible()
  await page.screenshot({ path: `${directory}/${file}-ask.png` })

  const dialog = await openSettings(page, locale)
  await expect(
    dialog.getByRole("status").filter({
      hasText: locale === "he" ? hebrew.whenClosed : english.whenClosed,
    })
  ).toBeVisible()
  await page.screenshot({ path: `${directory}/${file}-settings.png` })
}

test.describe("notification design captures", () => {
  test.skip(
    process.env.AOS_UI_CAPTURE !== "1",
    "Set AOS_UI_CAPTURE=1 to refresh the notification design captures."
  )

  for (const locale of ["en", "he"] as const) {
    test(`desktop ask and settings in ${locale}`, async ({ page }) => {
      await capture(page, { file: `desktop-${locale}`, locale })
    })
  }

  test("desktop ask and settings on a dark device", async ({ page }) => {
    await capture(page, { file: "dark-desktop-en", dark: true })
  })

  test.describe("phone", () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })

    test("mobile ask and settings in en", async ({ page }) => {
      await capture(page, { file: "mobile-en" })
    })

    test("mobile ask and settings on a dark device", async ({ page }) => {
      await capture(page, { file: "dark-mobile-en", dark: true })
    })
  })
})
