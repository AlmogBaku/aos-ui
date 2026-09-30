import { expect, test } from "./test"

test("an MCP App renders through the double frame, talks to the host, and enters full screen and returns inline three ways", async ({
  page,
}) => {
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeVisible()
  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Show me the mcp app")
  await page.getByRole("button", { name: "Send message" }).click()
  // The sandbox proxy is the outer frame; the App document is its only child.
  const app = page
    .frameLocator('iframe[title="show_launch_board app"]')
    .frameLocator("iframe")
  const close = page.getByRole("button", { name: "Exit full screen" })

  await expect(app.getByRole("heading", { name: "Launch board" })).toBeVisible()
  await expect(app.getByText('{"board":"launch"}')).toBeVisible()
  await expect(app.getByText("3 of 5 launch tasks are done.")).toBeVisible()
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

  await app.getByRole("button", { name: "Ask for a summary" }).click()
  await expect(app.getByText("Message sent")).toBeVisible()
  await expect(
    page.getByText("Summarize the launch board", { exact: true })
  ).toBeVisible()
})

test("the artifact view renders report.pdf, preview.png, test.html, pip, and download", async ({
  page,
  assertNoBrowserErrors,
}) => {
  void assertNoBrowserErrors
  await page.goto("/en")
  await expect(page.getByRole("tablist")).toBeVisible()

  // Helper: send a message and wait for the run to finish.
  const send = async (text: string) => {
    await page.getByRole("textbox", { name: "Message input" }).fill(text)
    await page.getByRole("button", { name: "Send message" }).click()
    await expect(
      page.getByRole("button", { name: "Stop response" })
    ).toBeHidden({ timeout: 10_000 })
  }

  // The artifact view frame is the inner frame inside the sandbox proxy.
  // Use .last() so each call targets the most-recently-added card.
  const artifactFrame = (toolCall: string) =>
    page
      .frameLocator(`iframe[title="${toolCall} app"]`)
      .last()
      .frameLocator("iframe")

  // --- report.pdf ---
  await send("Publish an artifact")
  const pdfFrame = artifactFrame("present_artifact")
  // The PDF renders its synthetic text.
  await expect(
    pdfFrame.getByText("Synthetic fixture file for AOS UI.")
  ).toBeVisible()

  // --- pip ---
  await pdfFrame.getByRole("button", { name: "Picture in picture" }).click()
  // The message card shows the "in side panel" placeholder.
  await expect(page.getByText("Shown in the side panel")).toBeVisible()
  // The side panel is open with the artifact view inside it.
  const panel = page.getByRole("complementary", { name: /present_artifact/ })
  await expect(panel).toBeVisible()

  // Escape from inside the panel returns the view to the message.
  await panel.press("Escape")
  await expect(page.getByText("Shown in the side panel")).toBeHidden()

  // Open pip again and close with the panel's close button.
  await pdfFrame.getByRole("button", { name: "Picture in picture" }).click()
  await expect(page.getByText("Shown in the side panel")).toBeVisible()
  await page
    .getByRole("complementary", { name: /present_artifact/ })
    .getByRole("button", { name: "Return to the message" })
    .click()
  await expect(page.getByText("Shown in the side panel")).toBeHidden()

  // --- download ---
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    pdfFrame.getByRole("button", { name: "Download" }).click(),
  ])
  expect(download.suggestedFilename()).toBe("report.pdf")

  // --- preview.png ---
  await send("Show a png artifact")
  const pngFrame = artifactFrame("present_artifact")
  // The image has loaded (no broken-image placeholder, real img element).
  await expect(pngFrame.locator("img[src^='data:image/png']")).toBeVisible()

  // --- test.html ---
  await send("Show an html artifact")
  const htmlFrame = artifactFrame("present_artifact")
  // The artifact view embeds the HTML in a sandboxed iframe. Confirm it
  // rendered: the "scripts are off" paragraph is the initial text and
  // stays that way because the sandbox prevents the script from running.
  const htmlInner = htmlFrame.frameLocator('iframe[title="HTML preview"]')
  await expect(htmlInner.getByText("scripts are off")).toBeVisible()
  await expect(htmlInner.getByText("scripts are on")).toBeHidden()
})
