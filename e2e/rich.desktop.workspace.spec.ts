import { expect, test, type Page } from "./test"

const english = {
  messageInput: "Message input",
  sendMessage: "Send message",
  newSession: "New session",
} as const

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
  const messageInput = locale === "he" ? "שדה הודעה" : english.messageInput
  const sendMessage = locale === "he" ? "שליחת הודעה" : english.sendMessage

  await page.getByRole("textbox", { name: messageInput }).fill(prompt)
  await page.getByRole("button", { name: sendMessage }).click()
}

async function createFreshSession(page: Page) {
  await page
    .getByRole("button", { name: english.newSession, exact: true })
    .first()
    .click()
  await expect(
    page.getByRole("tab", { name: english.newSession, exact: true })
  ).toHaveAttribute("aria-selected", "true")
}

function toolCard(page: Page, heading: string) {
  return page
    .locator('[data-slot="tool-chrome"]')
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) })
}

test("a question records one answer and closes every response control", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Ask me a question")

  const question = toolCard(page, "Which audience should the brief prioritize?")
  await expect(question).toHaveAttribute("data-state", "pending")
  await expect(
    question.getByRole("group", { name: "Answer options" })
  ).toBeVisible()

  await question.getByRole("option", { name: "Product team" }).click()

  await expect(question).toHaveAttribute("data-state", "answered")
  await expect(question.getByText("Response:")).toBeVisible()
  await expect(question.getByText("Product team", { exact: true })).toHaveCount(
    1
  )
  await expect(question.getByRole("button")).toHaveCount(0)
  await expect(question.getByRole("textbox")).toHaveCount(0)
})

test("permission choices preserve the provider label and visible persistent scope", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Request permission")

  const permission = toolCard(page, "Permission request")
  await expect(permission).toContainText(
    "Allow Aster to read the shared market dataset?"
  )
  await expect(
    permission.getByRole("button", { name: "Always for this dataset" })
  ).toBeVisible()
  await expect(
    permission.getByRole("list", { name: "Persistent permission scope" })
  ).toContainText("datasets/market/**")

  await permission
    .getByRole("button", { name: "Always for this dataset" })
    .click()
  await expect(permission.getByText("Keep this permission?")).toBeVisible()
  await expect(
    permission.getByRole("button", { name: "Confirm always" })
  ).toBeVisible()
  await expect(permission.getByText("datasets/market/**")).toBeVisible()

  await permission.getByRole("button", { name: "Confirm always" }).click()

  await expect(permission).toHaveAttribute("data-state", "answered")
  await expect(
    permission.getByText("Your provider recorded this decision.")
  ).toBeVisible()
  await expect(permission.getByRole("button")).toHaveCount(0)
  await expect(
    page.getByText("Your provider recorded the permission decision.", {
      exact: true,
    })
  ).toBeVisible()
})

test("message plans and session todos remain independent artifacts", async ({
  page,
}) => {
  await openWorkspace(page)
  await createFreshSession(page)

  const todoDock = page.locator('[data-slot="todo-dock"]')
  await expect(todoDock).toHaveCount(0)

  await sendPrompt(page, "Present a plan")

  const plans = page.locator('[data-slot="inline-plan"]')
  await expect(plans).toHaveCount(1)
  await expect(plans.getByText("Aggregate spend trends")).toBeVisible()
  await expect(todoDock).toHaveCount(0)

  await sendPrompt(page, "Update the todo list")

  await expect(todoDock).toBeVisible()
  await todoDock.locator("summary").click()
  await expect(
    todoDock.getByText("Review the result", { exact: true })
  ).toBeVisible()
  await expect(todoDock).toContainText("0 of 1 session tasks complete")
  await expect(plans).toHaveCount(1)
})

test("published artifacts open from Outputs and close cleanly", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Publish an artifact")

  const outputs = page
    .locator("details")
    .filter({ has: page.getByText("Artifacts", { exact: true }) })
  await outputs.locator("summary").click()
  const markdownOutput = outputs.locator("article").first()
  await expect(markdownOutput).toBeVisible()
  const open = markdownOutput.getByRole("button", { name: /^Open:/ })
  await open.click()

  const viewer = page.getByRole("region", { name: "Output preview" })
  await expect(viewer).not.toBeEmpty()
  await viewer.getByRole("button", { name: "Close preview" }).click()
  await expect(viewer).toBeHidden()
})

test("Monty stays inspect-only and malformed tools retain a safe JSON fallback", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Run Monty")

  const monty = toolCard(page, "Monty result")
  await expect(monty).toHaveAttribute("data-state", "complete")
  const sourceCode = monty.getByText("market.total_by_quarter()", {
    exact: true,
  })
  await expect(sourceCode).toBeHidden()
  await expect(monty.getByText("Q1’25: 365", { exact: true })).toBeVisible()
  await expect(monty.getByRole("button", { name: "Copy code" })).toBeVisible()
  await expect(monty.getByRole("button", { name: /run|execute/i })).toHaveCount(
    0
  )

  const inspectSource = monty.getByText("Inspect source code", { exact: true })
  await inspectSource.focus()
  await page.keyboard.press("Enter")
  await expect(sourceCode).toBeVisible()

  await monty.getByText("Inspect full result", { exact: true }).click()
  await expect(monty.getByText(/fixture-monty-001/)).toBeVisible()

  await sendPrompt(page, "Return a malformed tool")

  await page.getByRole("button", { name: "1 tool call" }).last().click()
  const fallback = page.locator('[data-slot="tool-call"]').last()
  await expect(fallback).toContainText("unknown_fixture_tool")
  await fallback.getByRole("button").click()
  await expect(fallback).toContainText('"unexpected"')
  await expect(fallback).toContainText("not-an-object")

  await sendPrompt(page, "Make Monty fail")

  const failedMonty = page.getByText("Fixture Monty execution failed", {
    exact: true,
  })
  await expect(failedMonty).toBeVisible()
  await expect(
    page.getByRole("button", { name: /\b(?:run|execute)\b/i })
  ).toHaveCount(0)
})

test("charts and maps expose complete textual alternatives", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Show a chart")

  const chart = toolCard(page, "Enterprise AI spend")
  await expect(chart.locator('[data-slot="chart"][data-chart]')).toBeVisible()
  await chart.getByRole("button", { name: "View chart data" }).click()
  const table = chart.getByRole("table", { name: "Enterprise AI spend data" })
  await expect(table).toBeVisible()
  await expect(table.getByRole("row", { name: /Q1’25 365 275/ })).toBeVisible()

  await sendPrompt(page, "Show a map")

  const map = toolCard(page, "Interview coverage")
  await expect(map.locator('[data-slot="geo-map"]')).toBeVisible()
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

test("delegated Subagent activity is visible and read-only", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Delegate to a subagent")

  // The seeded Market brief already contains an older Subagent artifact; the
  // last activity belongs to the response produced by this prompt.
  const activity = page.locator('[data-slot="tool-activity"]').last()
  await expect(activity).toHaveAttribute("data-state", "completed")
  await expect(
    activity.getByText("Data analyst", { exact: true })
  ).toBeVisible()
  await expect(activity.getByRole("button")).toHaveCount(0)
  await expect(
    activity.getByText(
      "Validated three segments against the fixture dataset.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(activity).not.toContainText("Transcript unavailable.")
})

test("a provider outage preserves partial content and a newly written draft", async ({
  page,
}) => {
  await openWorkspace(page)

  const input = page.getByRole("textbox", { name: english.messageInput })
  await input.fill("Simulate a provider outage")
  await page.getByRole("button", { name: english.sendMessage }).click()
  await input.fill("Keep this draft after the disconnect")

  await expect(
    page.getByText("The partial response is preserved.", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Fixture provider unavailable", { exact: true })
  ).toBeVisible()
  await expect(input).toHaveValue("Keep this draft after the disconnect")
})

test("stats display is a rich, structured artifact rather than a Todo", async ({
  page,
}) => {
  await openWorkspace(page)
  await sendPrompt(page, "Show launch metrics")

  const metrics = toolCard(page, "Launch metrics")
  await expect(metrics.locator('[data-slot="stats-display"]')).toBeVisible()
  await expect(metrics.getByText("Sessions")).toBeVisible()
  await expect(metrics.getByText("vs. last week")).toBeVisible()
  await expect(metrics.getByLabel("Session todos")).toHaveCount(0)
})

test("fixture demo omits Agent creation", async ({ page }) => {
  await openWorkspace(page)

  const newAgent = page.getByRole("button", { name: "New Agent", exact: true })
  await expect(newAgent).toHaveCount(0)
  await expect(page.getByText("Agent Creator", { exact: true })).toHaveCount(0)
})

test("Hebrew localizes rich controls while preserving provider content verbatim", async ({
  page,
}) => {
  await openWorkspace(page, "he")
  await sendPrompt(page, "Ask me a question", "he")

  const question = toolCard(page, "Which audience should the brief prioritize?")
  await expect(question).toHaveAttribute("dir", "rtl")
  await expect(question).toHaveAttribute("lang", "he")
  await expect(question).toContainText("נדרשת תשובה")
  await expect(
    question.getByRole("option", { name: "Executive team" })
  ).toHaveAttribute("dir", "auto")

  await question.getByRole("textbox", { name: "התשובה שלך" }).fill("הנהלה")
  await question.getByRole("button", { name: "שליחת תשובה" }).click()
  await expect(question).toHaveAttribute("data-state", "answered")
  await expect(question).toContainText("תשובה:")
  await expect(question).toContainText("הנהלה")

  await sendPrompt(page, "Show a chart", "he")
  const chart = toolCard(page, "Enterprise AI spend")
  await chart.getByRole("button", { name: "הצגת נתוני התרשים" }).click()
  await expect(
    chart.getByRole("table", { name: "Enterprise AI spend — נתוני תרשים" })
  ).toBeVisible()

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
