import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { FixtureWorkspace } from "@/lib/runtime-adapters/fixture/fixture-workspace"
import { AgentVisibilityUpdateError } from "@/lib/runtime-adapters/contracts"
import { ManageAgents } from "./manage-agents"

afterEach(cleanup)

it.each([
  ["en", "Shown in workspace", "Hidden from workspace", "Managed by provider"],
  ["he", "מוצג בסביבת העבודה", "מוסתר מסביבת העבודה", "מנוהל על ידי הספק"],
] as const)(
  "distinguishes shown and hidden read-only Agents in %s",
  async (locale, shown, hidden, ownership) => {
    const workspace = new FixtureWorkspace()
    const catalog = await workspace.listAgentCatalog()
    vi.spyOn(workspace, "listAgentCatalog").mockResolvedValue(
      catalog.map((entry) => ({ ...entry, editable: false }))
    )
    renderCatalog(workspace, locale)
    await screen.findByText("Aster")
    for (const entry of catalog) {
      const row = screen.getByText(entry.summary.name).closest("li")!
      expect(within(row).getByText(ownership)).toBeVisible()
      expect(
        within(row).getByText(entry.visibility === "visible" ? shown : hidden)
      ).toBeVisible()
      expect(within(row).queryByRole("switch")).toBeNull()
    }
  }
)

it.each([
  [
    "en",
    "provider-active",
    "Wait for active Sessions to finish, then try changing visibility again.",
  ],
  [
    "en",
    "pending-reload",
    "Visibility was saved but is not applied yet. Wait for active Sessions to finish, then try the visibility switch again.",
  ],
  ["en", null, "Visibility could not be saved. Try again."],
  [
    "he",
    "provider-active",
    "המתינו לסיום השיחות הפעילות, ואז נסו לשנות שוב את ההצגה בסביבת העבודה.",
  ],
  [
    "he",
    "pending-reload",
    "השינוי נשמר אך עדיין לא הוחל. המתינו לסיום השיחות הפעילות, ואז נסו שוב את מתג ההצגה בסביבת העבודה.",
  ],
  ["he", null, "לא ניתן לשמור את ההצגה בסביבת העבודה. נסו שוב."],
] as const)(
  "shows actionable %s guidance for %s without losing it on refresh",
  async (locale, code, guidance) => {
    const user = userEvent.setup()
    const workspace = new FixtureWorkspace()
    let notify!: () => void
    vi.spyOn(workspace, "subscribeAgentCatalog").mockImplementation(
      (listener) => {
        notify = listener
        return () => true
      }
    )
    vi.spyOn(workspace, "updateAgentVisibility").mockRejectedValueOnce(
      code
        ? new AgentVisibilityUpdateError(code, "Provider wording")
        : new Error("pending-reload")
    )
    renderCatalog(workspace, locale)
    const toggle = await screen.findByRole("switch", {
      name: `${(locale === "he" ? he : en).agentManagement.showInWorkspace}: Aster`,
    })
    await user.click(toggle)
    expect(await screen.findByRole("alert")).toHaveTextContent(guidance)
    await waitFor(() =>
      expect(toggle).not.toHaveAttribute("aria-disabled", "true")
    )
    await act(async () => {
      notify()
    })
    expect(screen.getByRole("alert")).toHaveTextContent(guidance)
    await user.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
    expect(screen.queryByRole("alert")).toBeNull()
  }
)

it("preserves mutation failure after a successful catalog notification refresh", async () => {
  const user = userEvent.setup()
  const workspace = new FixtureWorkspace()
  let notify!: () => void
  vi.spyOn(workspace, "subscribeAgentCatalog").mockImplementation(
    (listener) => {
      notify = listener
      return () => true
    }
  )
  const update = vi
    .spyOn(workspace, "updateAgentVisibility")
    .mockRejectedValueOnce(new Error("Rejected"))
  renderCatalog(workspace)
  const toggle = await screen.findByRole("switch", {
    name: "Show in workspace: Aster",
  })
  await user.click(toggle)
  expect(await screen.findByRole("alert")).toHaveTextContent(
    en.agentManagement.updateFailed
  )
  await act(async () => {
    notify()
  })
  expect(screen.getByRole("alert")).toHaveTextContent(
    en.agentManagement.updateFailed
  )
  await user.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
  expect(update).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole("alert")).toBeNull()
})

it("locks the switch until a delayed authoritative catalog refresh completes", async () => {
  const user = userEvent.setup()
  const workspace = new FixtureWorkspace()
  vi.spyOn(workspace, "subscribeAgentCatalog").mockImplementation(
    () => () => true
  )
  const readCatalog = workspace.listAgentCatalog.bind(workspace)
  let resolveCatalog!: (
    catalog: Awaited<ReturnType<typeof readCatalog>>
  ) => void
  const delayedCatalog = new Promise<Awaited<ReturnType<typeof readCatalog>>>(
    (resolve) => {
      resolveCatalog = resolve
    }
  )
  const list = vi
    .spyOn(workspace, "listAgentCatalog")
    .mockResolvedValueOnce(await readCatalog())
    .mockImplementationOnce(() => delayedCatalog)
  const update = vi.spyOn(workspace, "updateAgentVisibility")
  renderCatalog(workspace)
  const toggle = await screen.findByRole("switch", {
    name: "Show in workspace: Aster",
  })
  await user.click(toggle)
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  expect(toggle).toHaveAttribute("aria-disabled", "true")
  await user.click(toggle)
  expect(update).toHaveBeenCalledTimes(1)
  await act(async () => {
    resolveCatalog(await readCatalog())
  })
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
  expect(toggle).not.toHaveAttribute("aria-disabled", "true")
  await user.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"))
  expect(update).toHaveBeenNthCalledWith(2, "agent-aster", "visible")
})

function renderCatalog(
  workspace = new FixtureWorkspace(),
  locale: "en" | "he" = "en"
) {
  const onVisibilityChanged = vi.fn(async () => {})
  const onNewAgent = vi.fn(async () => {})
  const onOpenChange = vi.fn()
  const view = render(
    <ManageAgents
      open
      onOpenChange={onOpenChange}
      workspace={workspace}
      locale={locale}
      dictionary={locale === "he" ? he : en}
      onVisibilityChanged={onVisibilityChanged}
      onNewAgent={onNewAgent}
      onActionError={vi.fn()}
    />
  )
  return {
    onVisibilityChanged,
    onNewAgent,
    onOpenChange,
    unmount: view.unmount,
  }
}

it("does not reconcile a completed mutation after the workspace unmounts", async () => {
  const user = userEvent.setup()
  const workspace = new FixtureWorkspace()
  let finish!: () => void
  vi.spyOn(workspace, "updateAgentVisibility").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const reads = vi.spyOn(workspace, "listAgentCatalog")
  const { unmount, onVisibilityChanged } = renderCatalog(workspace)
  await user.click(
    await screen.findByRole("switch", { name: "Show in workspace: Aster" })
  )
  unmount()
  await act(async () => {
    finish()
  })
  expect(onVisibilityChanged).not.toHaveBeenCalled()
  expect(reads).toHaveBeenCalledOnce()
})

it("keeps a stale switch locked after reconciliation fails until catalog retry succeeds", async () => {
  const user = userEvent.setup()
  const workspace = new FixtureWorkspace()
  vi.spyOn(workspace, "subscribeAgentCatalog").mockImplementation(
    () => () => true
  )
  const initial = await workspace.listAgentCatalog()
  vi.spyOn(workspace, "listAgentCatalog")
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("Read failed"))
  const update = vi.spyOn(workspace, "updateAgentVisibility")
  renderCatalog(workspace)
  const toggle = await screen.findByRole("switch", {
    name: "Show in workspace: Aster",
  })
  await user.click(toggle)
  expect(await screen.findByRole("alert")).toHaveTextContent(
    en.agentManagement.loadFailed
  )
  expect(toggle).toHaveAttribute("aria-disabled", "true")
  await user.click(toggle)
  expect(update).toHaveBeenCalledOnce()
  await user.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
  expect(toggle).not.toHaveAttribute("aria-disabled", "true")
})

it("waits for provider confirmation and retains the switch state on failure", async () => {
  const user = userEvent.setup()
  const workspace = new FixtureWorkspace()
  let reject!: (error: Error) => void
  vi.spyOn(workspace, "updateAgentVisibility").mockImplementation(
    () =>
      new Promise((_, rejectPromise) => {
        reject = rejectPromise
      })
  )
  const { onVisibilityChanged } = renderCatalog(workspace)
  const toggle = await screen.findByRole("switch", {
    name: "Show in workspace: Aster",
  })
  await user.click(toggle)
  expect(toggle).toHaveAttribute("aria-checked", "true")
  expect(toggle).toHaveAttribute("aria-disabled", "true")
  reject(new Error("Provider rejected the update"))
  expect(await screen.findByRole("alert")).toHaveTextContent(
    en.agentManagement.updateFailed
  )
  expect(toggle).toHaveAttribute("aria-checked", "true")
  expect(onVisibilityChanged).not.toHaveBeenCalled()
})

it("recovers catalog loading errors", async () => {
  const user = userEvent.setup()
  const workspace = new FixtureWorkspace()
  vi.spyOn(workspace, "listAgentCatalog").mockRejectedValueOnce(
    new Error("Unavailable")
  )
  renderCatalog(workspace)
  expect(await screen.findByRole("alert")).toHaveTextContent(
    en.agentManagement.loadFailed
  )
  await user.click(screen.getByRole("button", { name: "Try again" }))
  await screen.findByRole("switch", { name: "Show in workspace: Aster" })
  expect(screen.queryByRole("alert")).toBeNull()
})

it("supports Hebrew switch labels and keyboard toggling, then hands off creation", async () => {
  const user = userEvent.setup()
  const { onVisibilityChanged, onNewAgent, onOpenChange } = renderCatalog(
    undefined,
    "he"
  )
  const toggle = await screen.findByRole("switch", {
    name: "הצגה בסביבת העבודה: Aster",
  })
  toggle.focus()
  await user.keyboard(" ")
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
  expect(onVisibilityChanged).toHaveBeenCalledOnce()
  await user.click(screen.getByRole("button", { name: "סוכן חדש" }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(onNewAgent).toHaveBeenCalledOnce()
})
