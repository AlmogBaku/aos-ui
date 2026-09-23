import { expect, type Locator } from "./test"

/** Opens a fold or tool-row disclosure the way a keyboard operator does. */
export async function expandByKeyboard(disclosure: Locator) {
  await disclosure.focus()
  await disclosure.press("Enter")
  await expect(disclosure).toHaveAttribute("aria-expanded", "true")
}
