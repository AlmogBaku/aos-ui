import { FIXTURE_ARTIFACT_VIEW_DOMAIN } from "../shared/presentation/views"

import { expect, test } from "./test"

// Served with AOS_UI_MCP_APP_STABLE_ORIGINS=http://*.mcp-apps.localhost:<port>,
// under which the fixture's artifact view asks for a stable origin of its own.
test("the artifact view loads from its own stable origin and shows its file there", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(
    page.getByRole("complementary", { name: "Agent details" })
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Show an html artifact")
  await page.getByRole("button", { name: "Send message" }).click()

  const stableOrigin = `http://${FIXTURE_ARTIFACT_VIEW_DOMAIN}:${new URL(page.url()).port}`
  const view = page
    .locator('iframe[aria-label="test.html"]')
    .first()
    .contentFrame()
    .locator("iframe")
    .contentFrame()
  await expect(
    view.getByRole("button", { name: "View test.html" })
  ).toBeVisible()
  // The view's document inherits its sandbox page's origin.
  expect(await view.locator("body").evaluate(() => self.origin)).toBe(
    stableOrigin
  )
})
