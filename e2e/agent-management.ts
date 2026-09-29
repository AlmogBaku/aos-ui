import { expect, type Page } from "./test"

const copy = {
  manage: "Manage Agents",
  open: "Open Agents",
  back: "Back to Agents",
} as const

/**
 * The mobile drawer hands off to Manage Agents, so closing the dialog has to
 * land focus back on the drawer trigger across the two overlays.
 */
export async function exerciseAgentManagement(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/en")
  await page.getByRole("button", { name: copy.open }).click()
  const back = page.getByRole("button", { name: copy.back })
  if (await back.isVisible()) await back.click()
  await page.getByRole("button", { name: copy.manage }).click()
  const dialog = page.getByRole("dialog", { name: copy.manage })
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: copy.open })).toBeFocused()
}
