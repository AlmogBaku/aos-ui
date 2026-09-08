import { expect, test } from "./test"

test("fixture demo does not expose Agent creation", async ({ page }) => {
  await page.goto("/en")
  await expect(page.getByRole("button", { name: /^Aster,/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "New Agent" })).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Select Agent: Agent Creator" })
  ).toHaveCount(0)
})
