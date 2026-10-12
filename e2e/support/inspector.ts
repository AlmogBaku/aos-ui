import { expect, type Page } from "../test"

/** The desktop inspector toggle and the panes it trades, in either locale. */
const copy = {
  hide: /^(?:Hide Agent details|הסתרת פרטי הסוכן)$/,
  show: /^(?:Show Agent details|הצגת פרטי הסוכן)$/,
  sessions: /^(?:Sessions|שיחות)$/,
  agentDetails: /^(?:Agent details|פרטי הסוכן)$/,
} as const

/**
 * The open desktop inspector lists the Agent's Sessions in place of the tab
 * strip, so a flow that drives tabs collapses it first.
 */
export async function collapseInspector(page: Page) {
  await page.getByRole("button", { name: copy.hide }).click()
  await expect(page.getByRole("tablist", { name: copy.sessions })).toBeVisible()
}

/** Shows the inspector's Session list again, which takes the tabs' place. */
export async function expandInspector(page: Page) {
  await page.getByRole("button", { name: copy.show }).click()
  await expect(
    page.getByRole("complementary", { name: copy.agentDetails })
  ).toBeVisible()
}
