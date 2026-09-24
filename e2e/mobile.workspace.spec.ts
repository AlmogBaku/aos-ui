import { expect, test, type Page } from "./test"
import { exerciseAgentManagement } from "./agent-management"
import { exerciseMessageActions } from "./message-actions"
import { exerciseSessionActions } from "./session-actions"
import { exerciseSessionTabs } from "./session-tabs"
import { holdsFocus } from "./support/focus"

test("mobile Session tabs and identity in en", async ({ page }) => {
  await exerciseSessionTabs(page, true)
})
test("mobile Session rows rename, pin, and list archived in en", async ({
  page,
}) => {
  await exerciseSessionActions(page, true)
})
test("mobile message menu opens by long press in en", async ({ page }) => {
  await exerciseMessageActions(page, true)
})
test("Manage Agents supports visibility controls in en", async ({ page }) => {
  await exerciseAgentManagement(page, true)
})

/** F6 lands on the transcript: inside the conversation, short of the composer. */
async function expectTranscriptFocus(page: Page) {
  const conversation = page.getByRole("main", { name: "Conversation" })
  await expect.poll(() => holdsFocus(conversation)).toBe(true)
  await expect(
    page.getByRole("textbox", { name: "Message input" })
  ).not.toBeFocused()
}

test("expanded reasoning remains independently scrollable", async ({
  page,
}) => {
  await page.goto("/en")
  // At 200% text scale the reasoning outgrows its capped panel.
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%"
  })

  // A settled turn folds the work it did, so its reasoning opens from there.
  await page
    .getByRole("button", { name: /^Worked/ })
    .first()
    .click()
  await page.getByRole("button", { name: "Reasoning" }).first().click()
  const reasoning = page.getByText(/^I’ll inspect the planning dataset/).first()
  await expect(reasoning).toBeVisible()

  /** The reasoning's own scroller and the thread's, innermost first. */
  const scrollers = (scroll: boolean) =>
    reasoning.evaluate((text, scroll) => {
      const found: HTMLElement[] = []
      for (
        let node = text.parentElement;
        node && found.length < 2;
        node = node.parentElement
      ) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY))
          found.push(node)
      }
      if (scroll && found[0]) found[0].scrollTop = found[0].scrollHeight
      return found.map((node) => node.scrollTop)
    }, scroll)

  const [, threadScrollTop] = await scrollers(false)
  await scrollers(true)
  await expect.poll(async () => (await scrollers(false))[0]).toBeGreaterThan(0)
  await expect
    .poll(async () => (await scrollers(false))[1])
    .toBe(threadScrollTop)
})

test("a Hebrew artifact opens in the focus-managed full-screen viewer", async ({
  page,
}) => {
  await page.goto("/he")
  await page
    .getByRole("textbox", { name: "שדה הודעה" })
    .fill("Publish an artifact")
  await page.getByRole("button", { name: "שליחת הודעה" }).click()
  // Click the published card once the run settles, so the thread no longer
  // scrolls under the press.
  const opens = page.getByRole("button", { name: "פתיחה" })
  await expect(opens).toHaveCount(2)
  await expect(page.getByRole("button", { name: "עצירת התשובה" })).toBeHidden()
  const open = opens.last()
  await open.click()

  const viewer = page.getByRole("dialog", {
    name: "תצוגה מקדימה של התוצר",
  })
  await expect(
    viewer.getByRole("region", { name: "תצוגה מקדימה של התוצר" })
  ).toHaveAttribute("dir", "rtl")
  await expect(viewer).not.toBeEmpty()
  await page.keyboard.press("Escape")
  await expect(open).toBeFocused()
})

test("mobile F6 skips CSS-hidden Agents and inspector panes", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeHidden()
  await expect(page.getByRole("complementary", { name: "Agents" })).toBeHidden()
  await expect(
    page.getByRole("complementary", { name: "Agent details" })
  ).toBeHidden()

  const input = page.getByRole("textbox", { name: "Message input" })
  await page.getByRole("button", { name: "Open Agents" }).focus()
  await page.keyboard.press("F6")
  await expectTranscriptFocus(page)
  await page.keyboard.press("F6")
  await expect(input).toBeFocused()
  await page.keyboard.press("F6")
  await expectTranscriptFocus(page)
})

test("mobile Return inserts a newline until Send is tapped", async ({
  page,
}) => {
  await page.goto("/en")
  const input = page.getByRole("textbox", { name: "Message input" })

  await input.focus()
  await page.keyboard.type("First line")
  await page.keyboard.press("Enter")
  await page.keyboard.type("Second line")

  await expect(input).toHaveValue("First line\nSecond line")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(input).toHaveValue("")
  await expect(
    page.getByText("First line\nSecond line", { exact: true })
  ).toBeVisible()
})

test("F6 reaches the remounted composer after a question resolves", async ({
  page,
}) => {
  await page.goto("/en")
  const input = page.getByRole("textbox", { name: "Message input" })
  await input.focus()
  await page.keyboard.type("Ask me a question")
  await page.getByRole("button", { name: "Send message" }).click()

  const questionComposer = page.getByRole("region", { name: "Questions" })
  await expect(questionComposer).toBeVisible()

  const option = questionComposer.getByRole("option", { name: "Product team" })
  await option.focus()
  await page.keyboard.press("Space")
  await questionComposer.getByRole("button", { name: "Send answer" }).click()

  await expect(questionComposer).not.toBeVisible()
  await expect(input).toBeVisible()

  await page.getByRole("button", { name: "Open Agents" }).focus()
  await page.keyboard.press("F6")
  await page.keyboard.press("F6")
  await expect(input).toBeFocused()
})
