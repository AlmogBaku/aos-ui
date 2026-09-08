import { expect, type Page } from "./test"

export async function exerciseAgentManagement(
  page: Page,
  mobile: boolean,
  locale: "en" | "he"
) {
  const copy =
    locale === "en"
      ? {
          manage: "Manage Agents",
          open: "Open Agents",
          show: "Show in workspace: Aster",
          heading: "Add an Agent to your workspace.",
          close: "Close panel",
        }
      : {
          manage: "ניהול סוכנים",
          open: "פתיחת רשימת הסוכנים",
          show: "הצגה בסביבת העבודה: Aster",
          heading: "הוסיפו סוכן לסביבת העבודה.",
          close: "סגירת החלונית",
        }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`/${locale}`)
  if (mobile) await page.getByRole("button", { name: copy.open }).click()
  await page.getByRole("button", { name: copy.manage }).click()
  const dialog = page.getByRole("dialog", { name: copy.manage })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr")
  await expect(dialog.getByRole("switch", { checked: false })).toHaveCount(1)
  await expect(dialog.getByRole("button", { name: copy.close })).toBeVisible()
  await expect(dialog).toHaveCSS("animation-name", "none")
  const toggle = dialog.getByRole("switch", { name: copy.show })
  const box = await toggle.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
  await toggle.focus()
  await page.keyboard.press("Space")
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  while (await dialog.getByRole("switch", { checked: true }).count()) {
    const next = dialog.getByRole("switch", { checked: true }).first()
    const name = await next.getAttribute("aria-label")
    await next.click()
    await expect(dialog.getByRole("switch", { name: name! })).toHaveAttribute(
      "aria-checked",
      "false"
    )
  }
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole("button", { name: mobile ? copy.open : copy.manage })
  ).toBeFocused()
  const main = page.getByRole("main")
  await expect(main.getByRole("heading", { name: copy.heading })).toBeVisible()
  await expect(main.getByRole("button")).toHaveCount(0)
  await expect(page.getByRole("tab")).toHaveCount(0)
  if (mobile) await page.getByRole("button", { name: copy.open }).click()
  await page.getByRole("button", { name: copy.manage }).click()
  await expect(dialog.getByRole("switch", { checked: false })).toHaveCount(6)
  await expect(dialog.getByRole("button", { name: copy.close })).toBeVisible()
}
