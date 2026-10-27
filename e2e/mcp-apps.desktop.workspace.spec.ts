import { expect, test } from "./test"

const ready = (page: import("./test").Page) =>
  expect(
    page.getByRole("complementary", { name: "Agent details" })
  ).toBeVisible()

test("an MCP App renders through the double frame on its sandbox origin, talks to the host, enters full screen and returns inline three ways, and cannot leave its sandbox", async ({
  page,
}) => {
  const reached: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "files.invalid")
      reached.push(request.url())
  })
  await page.goto("/en")
  await ready(page)
  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Show me the mcp app")
  await page.getByRole("button", { name: "Send message" }).click()
  // The sandbox proxy is the outer frame; the App document is its only child.
  const sandbox = page.locator('iframe[aria-label="show_launch_board app"]')
  const app = page
    .frameLocator('iframe[aria-label="show_launch_board app"]')
    .frameLocator("iframe")
  const close = page.getByRole("button", { name: "Exit full screen" })

  await expect(app.getByRole("heading", { name: "Launch board" })).toBeVisible()
  // On the sandbox origin the view keeps its own storage, and the sandbox page
  // it shares that origin with reaches no host the view never declared.
  await expect(app.getByText("Storage: kept")).toBeVisible()
  await expect(app.getByText("Network: refused")).toBeVisible()
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

  // The page frames only its sandbox origin, so taking the sandbox frame to
  // another address is refused, and the view, its page gone, is dropped.
  const refused = page.waitForEvent("console", (message) =>
    message.text().startsWith("Framing 'https://files.invalid/' violates")
  )
  await app.getByRole("button", { name: "Leave the sandbox" }).click()
  await refused
  await expect(page.getByText("The app could not be shown.")).toBeVisible()
  await expect(sandbox).toHaveCount(0)
  expect(reached).toEqual([])
})

/** Sends a message and waits for its run to finish. */
const send = async (page: import("./test").Page, text: string) => {
  await page.getByRole("textbox", { name: "Message input" }).fill(text)
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByRole("button", { name: "Stop response" })).toBeHidden({
    timeout: 10_000,
  })
}

/**
 * The artifact view frame is the inner frame inside the sandbox proxy. The
 * message's frame is named for its file, and comes before the side panel's.
 */
const artifactFrame = (page: import("./test").Page, filename: string) =>
  page
    .locator(`iframe[aria-label="${filename}"]`)
    .first()
    .contentFrame()
    .locator("iframe")
    .contentFrame()

/** The view inside the side panel named for `filename`. */
const panelView = (page: import("./test").Page, filename: string) =>
  page
    .getByRole("complementary", { name: filename })
    .locator("iframe")
    .first()
    .contentFrame()
    .locator("iframe")
    .contentFrame()

test("the artifact view shows report.pdf as a card that downloads, opens the side panel, and goes full screen", async ({
  page,
}) => {
  await page.goto("/en")
  await ready(page)

  await send(page, "Publish an artifact")
  const pdfFrame = artifactFrame(page, "report.pdf")
  // In its message the PDF is a card, without its pages.
  const card = pdfFrame.getByRole("button", { name: "View report.pdf" })
  await expect(card).toBeVisible()
  await expect(
    pdfFrame.getByText("Synthetic fixture file for AOS UI.")
  ).toHaveCount(0)

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
  const panelFrame = panelView(page, "report.pdf")
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
            'iframe[aria-label="report.pdf"]'
          ) != null
      )
    )
    .toBe(true)

  // Open pip again and close with the panel's close button.
  await card.click()
  await panel.getByRole("button", { name: "Return to the message" }).click()
  await expect(panel).toBeHidden()

  // --- full screen ---
  // The view grows over the page under a header named for its file and
  // previews the PDF whole; the header's close control takes focus, and Esc
  // returns the view to its message.
  await pdfFrame.getByRole("button", { name: "Full screen" }).click()
  const exit = page.getByRole("button", { name: "Exit full screen" })
  await expect(exit).toBeFocused()
  await expect(page.getByRole("heading", { name: "report.pdf" })).toBeVisible()
  await expect(
    pdfFrame.getByText("Synthetic fixture file for AOS UI.")
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(exit).toBeHidden()
  await expect(card).toBeVisible()
})

test("the artifact view shows preview.png alone in its message", async ({
  page,
}) => {
  await page.goto("/en")
  await ready(page)

  await send(page, "Show a png artifact")
  const pngFrame = artifactFrame(page, "preview.png")
  // In its message the image shows alone, and opens the side panel.
  // A broken image would show its file card in its place.
  await expect(pngFrame.getByAltText("preview.png")).toBeVisible()
  await expect(pngFrame.getByRole("button", { name: "Download" })).toHaveCount(
    0
  )
})

test("the artifact view reads crm-pipeline.xlsx in its worker and shows its sheet as a grid in the side panel", async ({
  page,
}) => {
  await page.goto("/en")
  await ready(page)

  await send(page, "Show a spreadsheet artifact")
  await artifactFrame(page, "crm-pipeline.xlsx")
    .getByRole("button", { name: "View crm-pipeline.xlsx" })
    .click()
  // The sheet worker starts from the server's script inside the sandbox and
  // answers with the cells as Excel shows them.
  const grid = panelView(page, "crm-pipeline.xlsx").getByRole("region", {
    name: "crm-pipeline.xlsx: Leads",
  })
  await expect(
    grid.getByRole("cell", { name: "Northwind Traders" })
  ).toBeVisible()
  await expect(grid.getByRole("cell", { name: "2026-11-14" })).toBeVisible()
})

test("the artifact view draws sales-proposal.docx as pages in a frame that runs no script of the document's own and never leaves it", async ({
  page,
}) => {
  await page.goto("/en")
  await ready(page)

  await send(page, "Show a word document artifact")
  await artifactFrame(page, "sales-proposal.docx")
    .getByRole("button", { name: "View sales-proposal.docx" })
    .click()
  const word = panelView(page, "sales-proposal.docx").frameLocator(
    'iframe[title="Word document"]'
  )
  await expect(word.getByText("Sales proposal")).toBeVisible()
  // The picture arrives as a data: address, the only one the view allows.
  await expect
    .poll(() =>
      word
        .getByRole("img")
        .first()
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0
        )
    )
    .toBe(true)
  // The embedded HTML part is never drawn, so its script never runs.
  await expect(word.getByText("embedded part")).toHaveCount(0)
  await expect(word.locator("iframe")).toHaveCount(0)

  // Its https link opens in a new tab, kept off the network here.
  await page
    .context()
    .route("https://example.invalid/**", (route) => route.fulfill())
  const opened = page.waitForEvent("popup")
  await word.getByRole("link", { name: "Read the pricing page" }).click()
  await expect(await opened).toHaveURL("https://example.invalid/pricing")
  // A link that is not https leaves the document in place.
  await word.getByRole("link", { name: "Run the macro" }).click()
  await expect(word.getByText("Sales proposal")).toBeVisible()
  // The policy runs only the frame's own scripts, so a script that reaches the
  // drawn page is refused.
  const refused = page.waitForEvent("console", (message) =>
    message.text().startsWith("Executing inline script violates")
  )
  await word.locator("body").evaluate((body) => {
    const script = document.createElement("script")
    script.textContent = "document.body.append('script ran')"
    body.append(script)
  })
  await refused
  await expect(word.getByText("script ran")).toHaveCount(0)
})

test("the artifact view runs test.html sandboxed with storage, opening its link in a new tab and refusing its fetch and its navigation", async ({
  page,
}) => {
  await page.goto("/en")
  await ready(page)

  await send(page, "Show an html artifact")
  // In its message the HTML is a card; the side panel runs its scripts in a
  // sandboxed iframe whose policy refuses the fetch the fixture tries.
  const reached: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "files.invalid")
      reached.push(request.url())
  })
  await artifactFrame(page, "test.html")
    .getByRole("button", { name: "View test.html" })
    .click()
  const htmlView = panelView(page, "test.html")
  const htmlInner = htmlView.frameLocator('iframe[title="HTML preview"]')
  // The file reads its storage before it says its scripts are on.
  await expect(htmlInner.getByText("scripts are on")).toBeVisible()
  await expect(htmlInner.getByText("fetch blocked")).toBeVisible()
  await expect(htmlInner.getByText("fetch allowed")).toBeHidden()
  // Its https link opens in a new tab, kept off the network here.
  await page
    .context()
    .route("https://example.invalid/**", (route) => route.fulfill())
  const opened = page.waitForEvent("popup")
  await htmlInner.getByRole("link", { name: "Open the report" }).click()
  await expect(await opened).toHaveURL("https://example.invalid/report")
  // The file may try to take its frame to another page, by script or by a
  // refresh; the view's frame-src refuses the load, the page stays where it
  // was, and the Preview tab shows the file again.
  const pageUrl = page.url()
  for (const leave of ["Leave by script", "Leave by refresh"]) {
    const refused = page.waitForEvent("console", (message) =>
      message.text().startsWith("Framing 'https://files.invalid/' violates")
    )
    await htmlInner.getByRole("button", { name: leave }).click()
    await refused
    expect(page.url()).toBe(pageUrl)
    await htmlView.getByRole("tab", { name: "Source" }).click()
    await htmlView.getByRole("tab", { name: "Preview" }).click()
    await expect(htmlInner.getByText("scripts are on")).toBeVisible()
  }
  expect(reached).toEqual([])
})
