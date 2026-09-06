import { expect, test, type Page } from "./test"

async function openWorkspace(page: Page) {
  await page.goto("/en")
  await expect(page.getByRole("tablist", { name: "Sessions" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
}

function commandsTrigger(page: Page) {
  return page.getByRole("button", { name: /^Commands \(/ })
}

async function runCommand(page: Page, title: string, shortcut = "Control+k") {
  await commandsTrigger(page).focus()
  await page.keyboard.press(shortcut)
  const dialog = page.getByRole("dialog", { name: "Commands" })
  await expect(dialog).toBeVisible()
  const search = dialog.getByRole("searchbox", { name: "Search commands" })
  await search.fill(title)
  const command = dialog
    .getByRole("button", { name: title, exact: true })
    .first()
  await expect(command).toBeVisible()
  await command.focus()
  await page.keyboard.press("Enter")
  await expect(dialog).toBeHidden()
}

async function activeRegion(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return null
    return active
      .closest<HTMLElement>(
        "[data-keyboard-region], [data-keyboard-transcript], [data-keyboard-composer]"
      )
      ?.getAttribute("data-keyboard-region")
  })
}

test("Commands search and execute, and Mod+/ opens the shortcut reference", async ({
  page,
}) => {
  await openWorkspace(page)

  await expect(
    page.getByRole("button", { name: /^Commands \((?:⌘|❖)\+K\)$/ })
  ).toBeVisible()
  await runCommand(page, "Open Session: Launch review")
  await expect(
    page.getByRole("tab", { name: "Launch review" })
  ).toHaveAttribute("aria-selected", "true")

  await commandsTrigger(page).focus()
  await page.keyboard.press("Control+/")
  const reference = page.getByRole("dialog", { name: "Keyboard reference" })
  await expect(reference).toBeVisible()
  await expect(reference).toContainText("Open Commands")
  await page.keyboard.press("Escape")
  await expect(reference).toBeHidden()
})

test("a captured shortcut drives its new behavior and Reset restores the default", async ({
  page,
}) => {
  await openWorkspace(page)

  await runCommand(page, "Keyboard Shortcuts")
  const settings = page.getByRole("dialog", { name: "Keyboard Shortcuts" })
  await expect(settings).toBeVisible()

  const shortcuts = settings.getByRole("searchbox", {
    name: "Search shortcuts",
  })
  await shortcuts.fill("Open Commands")
  const row = settings.locator('[role="list"] > div').filter({
    hasText: "Open Commands",
  })
  const setShortcut = row.getByRole("button", {
    name: "Set shortcut: Open Commands",
  })
  await setShortcut.click()
  await page.keyboard.press("Control+Shift+p")
  await expect(
    row.getByRole("button", { name: "Set shortcut: Open Commands" })
  ).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
  await page.keyboard.press("Control+Shift+p")
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible()
  await page.keyboard.press("Escape")

  await runCommand(page, "Keyboard Shortcuts", "Control+Shift+p")
  await expect(settings).toBeVisible()
  await shortcuts.fill("Open Commands")
  await row.getByRole("button", { name: "Reset", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()

  await commandsTrigger(page).focus()
  await page.keyboard.press("Control+k")
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible()
})

test("Shift+Enter inserts a newline while Enter sends the draft", async ({
  page,
}) => {
  await openWorkspace(page)

  const input = page.getByRole("textbox", { name: "Message input" })
  await input.focus()
  await page.keyboard.type("Keyboard draft")
  await page.keyboard.press("Shift+Enter")
  await page.keyboard.type("continued")
  await expect(input).toHaveValue("Keyboard draft\ncontinued")

  await page.keyboard.press("Enter")
  await expect(input).toHaveValue("")
  await expect(
    page.getByText("Keyboard draft\ncontinued", { exact: true })
  ).toBeVisible()
})

test("F6 traverses the visible Agents, Sessions, conversation, composer, and inspector regions", async ({
  page,
}) => {
  await openWorkspace(page)

  await page.getByRole("button", { name: /^Aster,/ }).focus()
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("sessions")
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("transcript")
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("composer")
  await page.keyboard.press("F6")
  await expect.poll(() => activeRegion(page)).toBe("inspector")
})

test("Session and Agent switches retain the unsent draft in its owning Session", async ({
  page,
}) => {
  await openWorkspace(page)

  const input = page.getByRole("textbox", { name: "Message input" })
  await input.fill("Draft that must stay with Market brief")

  await runCommand(page, "Open Session: Launch review")
  await expect(
    page.getByRole("tab", { name: "Launch review" })
  ).toHaveAttribute("aria-selected", "true")
  await expect(input).toHaveValue("")

  await runCommand(page, "Open Session: Market brief")
  await expect(input).toHaveValue("Draft that must stay with Market brief")

  await runCommand(page, "Select next Agent")
  await expect(page.getByRole("button", { name: /^Mica,/ })).toHaveAttribute(
    "aria-label",
    /Selected Agent/
  )
  await expect(
    page.getByRole("tab", { name: "Quarterly synthesis" })
  ).toHaveAttribute("aria-selected", "true")
  await expect(input).toHaveValue("")

  await runCommand(page, "Select previous Agent")
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(input).toHaveValue("Draft that must stay with Market brief")
})

test("wrapped history navigation restores a nonempty draft at both visual boundaries", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openWorkspace(page)
  await runCommand(page, "Open Session: Customer interviews")
  await expect(
    page.getByRole("tab", { name: "Customer interviews" })
  ).toHaveAttribute("aria-selected", "true")

  const input = page.getByRole("textbox", { name: "Message input" })
  const draft =
    "Keep this present draft while browsing the wrapped conversation history."
  await input.focus()
  await page.keyboard.type(draft)
  await page.keyboard.press("Control+Home")
  await page.keyboard.press("Meta+ArrowUp")
  await page.keyboard.press("ArrowUp")

  await expect(input).toHaveValue(
    "Interview theme 32: what changed in the customer workflow?"
  )
  await expect
    .poll(async () => (await input.boundingBox())?.height ?? 0)
    .toBeGreaterThan(48)

  await page.keyboard.press("ArrowDown")
  await expect(input).toHaveValue(draft)
  await expect(input).toBeFocused()
})

test("Escape closes only the active overlay and leaves the composer draft intact", async ({
  page,
}) => {
  await openWorkspace(page)

  const input = page.getByRole("textbox", { name: "Message input" })
  await input.fill("Draft survives overlay dismissal")
  await commandsTrigger(page).focus()
  await page.keyboard.press("Control+k")
  const commands = page.getByRole("dialog", { name: "Commands" })
  await expect(commands).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(commands).toBeHidden()
  await expect(commandsTrigger(page)).toBeFocused()
  await expect(input).toHaveValue("Draft survives overlay dismissal")

  await commandsTrigger(page).focus()
  await page.keyboard.press("Control+/")
  const reference = page.getByRole("dialog", { name: "Keyboard reference" })
  await expect(reference).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(reference).toBeHidden()
  await expect(commandsTrigger(page)).toBeFocused()
})

test("Escape cancels a busy run without dropping queued work, which resumes explicitly", async ({
  page,
}) => {
  await openWorkspace(page)

  const input = page.getByRole("textbox", { name: "Message input" })
  await input.focus()
  await page.keyboard.type("Start a long fixture run")
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("button", { name: "Stop generating" })
  ).toBeVisible()

  await input.focus()
  await page.keyboard.type("Queued follow-up")
  await page.keyboard.press("Enter")
  const queued = page.getByRole("region", { name: "Queued messages" })
  await expect(queued).toContainText("Queued follow-up")

  const transcriptControl = page
    .locator('[data-slot="aui_thread-viewport"]')
    .getByRole("button", { name: /Show .* more step/ })
    .first()
  await transcriptControl.focus()
  await page.keyboard.press("Escape")

  await expect(
    page.getByRole("button", { name: "Stop generating" })
  ).toBeHidden()
  await expect(queued).toContainText("Queued follow-up")
  await expect(
    page.getByRole("button", { name: "Resume queued message" })
  ).toBeVisible()

  const resume = page.getByRole("button", { name: "Resume queued message" })
  await resume.focus()
  await page.keyboard.press("Enter")
  await expect(queued).toBeHidden()
  await expect(
    page.getByText("Queued follow-up", { exact: true })
  ).toBeVisible()
})
