import { expect, test } from "./test"
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

test.describe("notification design captures", () => {
  test.skip(
    process.env.AOS_UI_CAPTURE !== "1",
    "Set AOS_UI_CAPTURE=1 to refresh the notification design captures."
  )

  for (const locale of ["en", "he"] as const) {
    test(`desktop ask and settings in ${locale}`, async ({ page }) => {
      await prepare(page, "default", locale)
      await startSelectedRun(page)
      await expect(askHeading(page, locale)).toBeVisible()
      await page.screenshot({ path: `${directory}/desktop-${locale}-ask.png` })

      const dialog = await openSettings(page, locale)
      await expect(
        dialog.getByRole("status").filter({
          hasText: locale === "he" ? hebrew.whenClosed : english.whenClosed,
        })
      ).toBeVisible()
      await page.screenshot({
        path: `${directory}/desktop-${locale}-settings.png`,
      })
    })
  }

  test.describe("phone", () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })

    test("mobile ask over the composer and its settings in en", async ({
      page,
    }) => {
      await prepare(page)
      await startSelectedRun(page)
      await expect(askHeading(page)).toBeVisible()
      await page.screenshot({ path: `${directory}/mobile-en-ask.png` })

      const dialog = await openSettings(page)
      await expect(
        dialog.getByRole("status").filter({ hasText: english.whenClosed })
      ).toBeVisible()
      await page.screenshot({ path: `${directory}/mobile-en-settings.png` })
    })
  })
})
