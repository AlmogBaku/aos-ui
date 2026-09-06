import { expect, test, type Page } from "./test"

import type { ReadyAgentSummary } from "../lib/runtime-adapters/contracts"
import type { FixtureWorkspace } from "../lib/runtime-adapters/fixture/fixture-workspace"

const readyAgent: ReadyAgentSummary = {
  kind: "ready",
  id: "agent-sora",
  name: "Sora",
  description: "Customer insight",
  icon: { kind: "symbol", symbol: "spark", tone: "teal" },
}

async function updateSelectedDraft(page: Page, action: "promote" | "fail") {
  await page.evaluate(
    async ({ action, agent }) => {
      const workspace: FixtureWorkspace | undefined =
        window.__AOS_UI_FIXTURE_WORKSPACE__
      if (!workspace) throw new Error("Fixture workspace driver is unavailable")
      const draft = (await workspace.listAgents()).find(
        ({ kind }) => kind === "provisional"
      )
      if (!draft) throw new Error("Fixture Agent draft is unavailable")

      if (action === "promote") {
        workspace.promoteAgentDraft(draft.id, agent)
      } else {
        workspace.failAgentDraftActivation(
          draft.id,
          "OpenCode did not discover Sora",
          agent
        )
      }
    },
    { action, agent: readyAgent }
  )
}

async function openWorkspace(page: Page) {
  await page.goto("/en")
  await expect(page.getByRole("tablist", { name: "Sessions" })).toBeVisible()
}

function agentsPanel(page: Page) {
  return page.getByRole("complementary", { name: "Agents" })
}

function launchBuilder(page: Page) {
  return agentsPanel(page).locator('button[aria-label="New Agent"]').first()
}

function agentList(page: Page) {
  return agentsPanel(page).getByRole("navigation", { name: "Agents" })
}

test("each Builder launch creates a distinct provisional Agent with one Builder Session", async ({
  page,
}) => {
  await openWorkspace(page)

  await launchBuilder(page).click()

  await expect(
    agentList(page).getByRole("button", {
      name: "New Agent, Status: Needs attention, Selected Agent",
    })
  ).toBeVisible()
  await expect(
    page.getByText("Hey, let's build a new agent.", { exact: true })
  ).toBeVisible()
  const fixtureQuestion = page.locator('[data-slot="tool-chrome"]').filter({
    has: page.getByRole("heading", {
      name: "What do you mostly want this Agent to help with?",
    }),
  })
  await expect(
    fixtureQuestion.getByRole("group", { name: "Answer options" })
  ).toBeVisible()
  await fixtureQuestion.getByRole("option", { name: "Work projects" }).click()
  await expect(fixtureQuestion).toHaveAttribute("data-state", "answered")
  await expect(
    fixtureQuestion.getByText("Work projects", { exact: true })
  ).toHaveCount(1)
  await expect(page.getByText("agent-builder", { exact: true })).toHaveCount(0)
  await expect(
    page.getByRole("tablist", { name: "Sessions" }).getByRole("tab")
  ).toHaveCount(1)
  await expect(page.getByRole("tab", { name: "New Agent" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(
    page.getByRole("button", { name: "Close session: New Agent" })
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "New session" })).toHaveCount(0)
  await expect(page.locator('[data-slot="todo-dock"]')).toHaveCount(0)

  await launchBuilder(page).click()

  await expect(
    agentList(page).getByRole("button", { name: /^New Agent(?:,|$)/ })
  ).toHaveCount(2)
  await expect(
    page.getByRole("tablist", { name: "Sessions" }).getByRole("tab")
  ).toHaveCount(1)
})

test("draft deletion is explicit, cancelable, and restores focus", async ({
  page,
}) => {
  await openWorkspace(page)
  await launchBuilder(page).click()

  const inspector = page.getByRole("complementary", { name: "Agent details" })
  const deleteDraft = inspector.getByRole("button", {
    name: "Delete Agent draft",
  })
  await deleteDraft.click()
  await expect(
    page.getByRole("heading", { name: "Delete this Agent draft?" })
  ).toBeVisible()

  await page.getByRole("button", { name: "Keep draft" }).click()

  await expect(deleteDraft).toBeFocused()
  await expect(
    agentList(page).getByRole("button", {
      name: "New Agent, Status: Needs attention, Selected Agent",
    })
  ).toBeVisible()

  await deleteDraft.click()
  await page.getByRole("button", { name: "Delete draft" }).click()

  await expect(
    agentList(page).getByRole("button", { name: /^New Agent(?:,|$)/ })
  ).toHaveCount(0)
  await expect(
    agentList(page).getByRole("button", {
      name: "Aster, Status: Running, Selected Agent",
    })
  ).toBeFocused()
})

test("Builder completion promotes the draft and selects its first ordinary Session", async ({
  page,
}) => {
  await openWorkspace(page)
  await launchBuilder(page).click()
  await expect(
    agentList(page).getByRole("button", {
      name: "New Agent, Status: Needs attention, Selected Agent",
    })
  ).toBeVisible()

  await updateSelectedDraft(page, "promote")

  await expect(
    agentList(page).getByRole("button", { name: "Sora, Selected Agent" })
  ).toBeVisible()
  await expect(
    agentList(page).getByRole("button", { name: /^New Agent(?:,|$)/ })
  ).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "New session" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
})

test("activation failure remains visible and retry completes promotion", async ({
  page,
}) => {
  await openWorkspace(page)
  await launchBuilder(page).click()

  await updateSelectedDraft(page, "fail")

  const inspector = page.getByRole("complementary", { name: "Agent details" })
  await expect(inspector.getByText("Couldn’t finish setup")).toBeVisible()
  await expect(
    inspector.getByText("OpenCode did not discover Sora")
  ).toBeVisible()

  await inspector.getByRole("button", { name: "Retry Agent creation" }).click()

  await expect(
    agentList(page).getByRole("button", { name: "Sora, Selected Agent" })
  ).toBeVisible()
  await expect(page.getByRole("tab", { name: "New session" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(inspector.getByText("Couldn’t finish setup")).toHaveCount(0)
})
