import type { Locator } from "../test"

/** Whether the focused element is `region` itself or sits inside it. */
export function holdsFocus(region: Locator) {
  return region.evaluate((element) => element.contains(document.activeElement))
}
