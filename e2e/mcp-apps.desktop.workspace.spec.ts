import { expect, test, type Page } from "./test"

async function openAppInThread(page: Page) {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeVisible()
  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Show me the mcp app")
  await page.getByRole("button", { name: "Send message" }).click()
  // The sandbox proxy is the outer frame; the App document is its only child.
  return page
    .frameLocator('iframe[title="show_launch_board app"]')
    .frameLocator("iframe")
}

test("an MCP App renders through the double frame and talks to the host", async ({
  page,
}) => {
  const app = await openAppInThread(page)

  await expect(app.getByRole("heading", { name: "Launch board" })).toBeVisible()
  await expect(app.getByText('{"board":"launch"}')).toBeVisible()
  await expect(app.getByText("3 of 5 launch tasks are done.")).toBeVisible()

  await app.getByRole("button", { name: "Refresh board" }).click()
  await expect(app.getByText("Board refreshed (1): 4 of 5 done.")).toBeVisible()

  await app.getByRole("button", { name: "Ask for a summary" }).click()
  await expect(app.getByText("Message sent")).toBeVisible()
  await expect(
    page.getByText("Summarize the launch board", { exact: true })
  ).toBeVisible()
})

test("an MCP App enters full screen and returns inline three ways", async ({
  page,
}) => {
  const app = await openAppInThread(page)
  const close = page.getByRole("button", { name: "Exit full screen" })
  await expect(app.getByText("Display mode: inline")).toBeVisible()
  await app.getByRole("button", { name: "Refresh board" }).click()
  const refreshed = app.getByText("Board refreshed (1): 4 of 5 done.")
  await expect(refreshed).toBeVisible()

  await app.getByRole("button", { name: "Fullscreen" }).click()
  await expect(close).toBeVisible()
  await expect(app.getByText("Display mode: fullscreen")).toBeVisible()
  await close.click()
  await expect(close).toBeHidden()
  await expect(app.getByText("Display mode: inline")).toBeVisible()

  await app.getByRole("button", { name: "Fullscreen" }).click()
  await close.focus()
  await page.keyboard.press("Escape")
  await expect(close).toBeHidden()
  await expect(app.getByText("Display mode: inline")).toBeVisible()

  await app.getByRole("button", { name: "Fullscreen" }).click()
  await expect(close).toBeVisible()
  await app.getByRole("button", { name: "Inline view" }).click()
  await expect(close).toBeHidden()
  // The frame kept its document across every change: the App still holds
  // what it showed before the first full screen.
  await expect(refreshed).toBeVisible()
})
