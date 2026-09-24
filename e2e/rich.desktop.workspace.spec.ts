import { expect, test, type Page } from "./test"

async function openWorkspace(page: Page, locale: "en" | "he" = "en") {
  await page.goto(`/${locale}`)
  await expect(page.getByRole("tablist")).toBeVisible()
  await expect(page.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
}

async function sendPrompt(
  page: Page,
  prompt: string,
  locale: "en" | "he" = "en"
) {
  const messageInput = locale === "he" ? "שדה הודעה" : "Message input"
  const sendMessage = locale === "he" ? "שליחת הודעה" : "Send message"

  await page.getByRole("textbox", { name: messageInput }).fill(prompt)
  await page.getByRole("button", { name: sendMessage }).click()
}

/**
 * The newest App view a tool drew. The sandbox proxy is the outer frame, named
 * after the tool; the App document is its only child.
 */
function appView(page: Page, toolName: string) {
  return page
    .locator(`iframe[title="${toolName} app"]`)
    .last()
    .contentFrame()
    .locator("iframe")
    .contentFrame()
}

test("charts and maps expose complete textual alternatives", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Show a chart")

  // Wait for this call's view: the thread already holds an earlier chart.
  const chart = appView(page, "render_chart")
  await expect(
    chart.getByRole("heading", { name: "Enterprise AI spend" })
  ).toBeVisible()
  await chart.getByRole("button", { name: "View chart data" }).click()
  const table = chart.getByRole("table", { name: "Enterprise AI spend data" })
  await expect(table).toBeVisible()
  await expect(table.getByRole("row", { name: /Q1’25 365 275/ })).toBeVisible()

  await sendPrompt(page, "Show a map")

  const map = appView(page, "render_map")
  await map.getByRole("button", { name: "View map locations" }).click()
  const locations = map.getByRole("list", {
    name: "Interview coverage locations",
  })
  await expect(locations).toBeVisible()
  await expect(locations).toContainText("London — 51.5072, -0.1276")
  await expect(locations).toContainText("Tel Aviv — 32.0853, 34.7818")
})

test("Mermaid markdown renders a safe diagram with inspectable source", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Show a Mermaid diagram")

  await expect(page.getByRole("img", { name: "Mermaid diagram" })).toBeVisible()
  await page.getByRole("button", { name: "View diagram source" }).click()
  await expect(page.getByText("flowchart LR", { exact: false })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Copy diagram source" })
  ).toBeVisible()
  const diagram = page
    .getByRole("img", { name: "Mermaid diagram" })
    .locator("xpath=ancestor::section")
  await expect(
    diagram.getByRole("button", { name: "Run", exact: true })
  ).toHaveCount(0)
})

test("malformed and oversized Mermaid keep safe source fallbacks", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Show malformed Mermaid")

  await expect(
    page.getByText("Diagram could not be rendered.", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Request -->", { exact: false })).toBeVisible()

  await sendPrompt(page, "Show oversized Mermaid")
  await expect(
    page.getByText("Diagram source is too large to render safely.", {
      exact: true,
    })
  ).toBeVisible()
})

test("Hebrew localizes rich controls while preserving provider content verbatim", async ({
  page,
}) => {
  await openWorkspace(page, "he")
  await sendPrompt(page, "Ask me a question", "he")

  const composerHe = page.getByRole("region", { name: "שאלות" })
  const option = composerHe.getByRole("option", { name: "Executive team" })
  await expect(option).toHaveAttribute("dir", "auto")
  await option.click()
  await composerHe.getByRole("button", { name: "שליחת תשובה" }).click()
  await expect(composerHe).not.toBeVisible()

  const recordHe = page
    .getByRole("heading", {
      name: "Which audience should the brief prioritize?",
      level: 2,
    })
    .locator("xpath=ancestor::section[1]")
  await expect(recordHe).toHaveAttribute("dir", "rtl")
  await expect(recordHe).toHaveAttribute("lang", "he")

  await sendPrompt(page, "Show a Mermaid diagram", "he")
  await expect(page.getByRole("img", { name: "תרשים Mermaid" })).toBeVisible()
  await page.getByRole("button", { name: "הצגת מקור התרשים" }).click()
  const mermaidSource = page.getByText("flowchart LR", { exact: false })
  await expect(mermaidSource).toBeVisible()
  await expect(mermaidSource.locator("xpath=ancestor::pre")).toHaveAttribute(
    "dir",
    "ltr"
  )
})

test("a provider outage preserves partial content and a newly written draft", async ({
  page,
}) => {
  await openWorkspace(page)

  await sendPrompt(page, "Simulate a provider outage")
  const input = page.getByRole("textbox", { name: "Message input" })
  await input.fill("Keep this draft after the disconnect")

  await expect(
    page.getByText("The partial response is preserved.", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Fixture provider unavailable", { exact: true })
  ).toBeVisible()
  await expect(input).toHaveValue("Keep this draft after the disconnect")
})
