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
    .frameLocator('iframe[aria-label="show_launch_board app"]')
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
}) => {
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
  // Use locator().last() to target the most-recently-added card when
  // multiple present_artifact calls are in the conversation.
  const artifactFrame = () =>
    page
      .locator('iframe[aria-label="present_artifact app"]')
      .last()
      .contentFrame()
      .locator("iframe")
      .contentFrame()

  // --- report.pdf ---
  await send("Publish an artifact")
  const pdfFrame = artifactFrame()
  // In its message the PDF is a card, without its pages.
  const card = pdfFrame.getByRole("button", { name: "View report.pdf" })
  await expect(card).toBeVisible()
  await expect(pdfFrame.getByText("Synthetic fixture file for AOS UI.")).toHaveCount(0)

  // --- download ---
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    pdfFrame.getByRole("button", { name: "Download" }).click(),
  ])
  expect(download.suggestedFilename()).toBe("report.pdf")

  // --- pip ---
  await card.click()
  // The side panel, named for the file, renders the PDF's pages, while the
  // message keeps its card.
  const panel = page.getByRole("complementary", { name: "report.pdf" })
  const panelFrame = panel
    .locator("iframe")
    .first()
    .contentFrame()
    .locator("iframe")
    .contentFrame()
  await expect(
    panelFrame.getByText("Synthetic fixture file for AOS UI.")
  ).toBeVisible()
  await expect(card).toBeVisible()

  // Escape in the panel's view returns focus to the message's card.
  await panelFrame.getByRole("region", { name: "PDF preview" }).press("Escape")
  await expect(panel).toBeHidden()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.querySelector(
            'iframe[aria-label="present_artifact app"]'
          ) != null
      )
    )
    .toBe(true)

  // Open pip again and close with the panel's close button.
  await card.click()
  await panel.getByRole("button", { name: "Return to the message" }).click()
  await expect(panel).toBeHidden()

  // --- preview.png ---
  await send("Show a png artifact")
  const pngFrame = artifactFrame()
  // In its message the image shows alone, and opens the side panel.
  // A broken image would show its file card in its place.
  await expect(pngFrame.getByAltText("preview.png")).toBeVisible()
  await expect(pngFrame.getByRole("button", { name: "Download" })).toHaveCount(0)

  // --- test.html ---
  await send("Show an html artifact")
  // In its message the HTML is a card; the side panel runs its scripts in a
  // sandboxed iframe whose policy refuses the fetch the fixture tries.
  await artifactFrame().getByRole("button", { name: "View test.html" }).click()
  const htmlInner = page
    .getByRole("complementary", { name: "test.html" })
    .locator("iframe")
    .first()
    .contentFrame()
    .locator("iframe")
    .contentFrame()
    .frameLocator('iframe[title="HTML preview"]')
  await expect(htmlInner.getByText("scripts are on")).toBeVisible()
  await expect(htmlInner.getByText("fetch blocked")).toBeVisible()
  await expect(htmlInner.getByText("fetch allowed")).toBeHidden()
})
