import { act, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"

import {
  deferred,
  renderedConversation,
  renderNavigation,
  renderWorkspace,
  resetWorkspaceBetweenTests,
  useCatalogRuntime,
  type WorkspaceNavigation,
} from "./aos-ui-workspace.test-helpers"

vi.mock("react-router", () => import("./test-utils/window-router"))

resetWorkspaceBetweenTests()

/** The creator's own Session opens as a conversation under its name. */
const expectCreatorConversation = (nav: WorkspaceNavigation) => {
  expect(nav.selectedAgent?.name).toBe("Agent Creator")
  expect(renderedConversation(nav)).toBeTruthy()
}

describe("Agent management", () => {
  it("defaults to an ordinary Agent when the creator is listed first", async () => {
    const view = renderNavigation(() =>
      useCatalogRuntime({ creatorFirst: true })
    )

    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))
  })

  it("resolves an explicit creator route when no ordinary Agents exist", async () => {
    window.history.replaceState({}, "", "/agent-builder")
    const view = renderNavigation(() =>
      useCatalogRuntime({ creatorOnly: true })
    )

    await waitFor(() => expectCreatorConversation(view.nav))
  })

  it("waits for a delayed catalog before resolving a creator route", async () => {
    const agentGate = deferred<void>()
    window.history.replaceState({}, "", "/agent-builder")
    const view = renderNavigation(() =>
      useCatalogRuntime({ creatorOnly: true, agentGate: agentGate.promise })
    )

    await act(
      () => new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    )
    await act(async () => agentGate.resolve())

    await waitFor(() => expectCreatorConversation(view.nav))
  })

  // Full mount: hiding goes through the dialog, then reconciles the rail and
  // the conversation's empty roster, three parts only the workspace joins.
  it("shows hidden Agents and reconciles hiding the selected and last visible Agent", async () => {
    const user = userEvent.setup()
    renderWorkspace(useCatalogRuntime)
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

  // Full mount: the empty roster, the Manage Agents dialog's direction and
  // creation offer, and focus return span the workspace and the shell.
  it.each(["en", "he"] as const)(
    "renders a truly empty roster in %s and retains management",
    async (locale) => {
      const user = userEvent.setup()
      const dictionary = locale === "he" ? he : en
      renderWorkspace(
        () => useCatalogRuntime({ empty: true, readOnly: true }),
        { locale }
      )
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
      expect(
        within(dialog).queryByRole("button", {
          name: dictionary.actions.newAgent,
        })
      ).toBeNull()
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
