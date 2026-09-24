import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"

import { CatalogFixture, deferred } from "./aos-ui-workspace.test-helpers"

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: window.location.pathname }),
  useNavigate: () => (href: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"](
      null,
      "",
      href
    )
  },
}))

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  window.localStorage.clear()
})
afterEach(cleanup)

describe("Agent management", () => {
  it("defaults to an ordinary Agent when the creator is listed first", async () => {
    render(<CatalogFixture creatorFirst />)

    expect(
      await screen.findByRole("button", { name: /^Aster,/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("resolves an explicit creator route when no ordinary Agents exist", async () => {
    window.history.replaceState({}, "", "/agent-builder")
    render(<CatalogFixture creatorOnly />)

    expect(
      within(
        await screen.findByRole("main", { name: "Conversation" })
      ).getByRole("heading", { name: "What would you like to work on?" })
    ).toBeVisible()
    expect(
      within(
        screen.getByRole("complementary", { name: "Agent details" })
      ).getByText("Agent Creator")
    ).toBeVisible()
  })

  it("waits for a delayed catalog before resolving a creator route", async () => {
    const agentGate = deferred<void>()
    window.history.replaceState({}, "", "/agent-builder")
    render(<CatalogFixture creatorOnly agentGate={agentGate.promise} />)

    await act(
      () => new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    )
    await act(async () => agentGate.resolve())

    expect(
      await within(
        screen.getByRole("complementary", { name: "Agent details" })
      ).findByText("Agent Creator")
    ).toBeVisible()
  })

  it("keeps the creator out of Agent management catalogs", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture creatorInCatalog />)

    await user.click(
      await screen.findByRole("button", { name: "Manage Agents" })
    )
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    expect(within(dialog).queryByText("Agent Creator")).toBeNull()
  })

  it("shows hidden Agents and reconciles hiding the selected and last visible Agent", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture />)
    await screen.findByRole("button", { name: /^Aster,/ })
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    const switches = await within(dialog).findAllByRole("switch")
    expect(
      switches.some((item) => item.getAttribute("aria-checked") === "false")
    ).toBe(true)
    await user.click(
      within(dialog).getByRole("switch", { name: "Show in workspace: Aster" })
    )
    await user.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Mica,/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )
    expect(screen.queryByRole("button", { name: /^Aster,/ })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const reopened = await screen.findByRole("dialog", {
      name: "Manage Agents",
    })
    for (const toggle of await within(reopened).findAllByRole("switch", {
      checked: true,
    })) {
      await user.click(toggle)
      await waitFor(() =>
        expect(toggle).toHaveAttribute("aria-checked", "false")
      )
    }
    await user.keyboard("{Escape}")
    const main = screen.getByRole("main", { name: "Conversation" })
    expect(
      within(main).getByRole("heading", {
        name: "Add an Agent to your workspace.",
      })
    ).toBeVisible()
    expect(within(main).queryByText("Agent Creator")).toBeNull()
    expect(
      within(main).getByRole("button", { name: "New Agent" })
    ).toBeVisible()
  })

  it("keeps provider-managed entries read-only and omits unavailable creation", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture readOnly />)
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    expect(
      (await within(dialog).findAllByText("Managed by provider")).length
    ).toBeGreaterThan(0)
    expect(within(dialog).queryByRole("switch")).toBeNull()
    expect(
      within(dialog).queryByRole("button", { name: "New Agent" })
    ).toBeNull()
  })

  it.each(["en", "he"] as const)(
    "renders a truly empty roster in %s and retains management",
    async (locale) => {
      const user = userEvent.setup()
      const dictionary = locale === "he" ? he : en
      render(<CatalogFixture empty readOnly locale={locale} />)
      const heading =
        locale === "en"
          ? "Add an Agent to your workspace."
          : "הוסיפו סוכן לסביבת העבודה."
      await screen.findByRole("heading", { name: heading })
      const main = screen.getByRole("main", {
        name: dictionary.workspace.conversation,
      })
      expect(
        within(main).queryByRole("button", {
          name: dictionary.actions.newAgent,
        })
      ).toBeNull()
      await user.click(
        screen.getByRole("button", { name: dictionary.workspace.manageAgents })
      )
      const dialog = await screen.findByRole("dialog", {
        name: dictionary.workspace.manageAgents,
      })
      expect(dialog).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr")
      await user.keyboard("{Escape}")
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: dictionary.workspace.manageAgents,
          })
        ).toHaveFocus()
      )
    }
  )
})
