import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"

import { WorkspacePreferences } from "./workspace-preferences"

const setTheme = vi.fn()
const refresh = vi.fn()
let theme = "system"
let pathname = "/en"

vi.mock("next-themes", () => ({
  useTheme: () => ({ setTheme, theme }),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh }),
}))

beforeEach(() => {
  theme = "system"
  pathname = "/en"
  window.history.replaceState({}, "", "/")
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  setTheme.mockReset()
  refresh.mockReset()
})

describe("WorkspacePreferences", () => {
  it("offers a localized single-select light, system, and dark theme control", async () => {
    const user = userEvent.setup()
    render(<WorkspacePreferences locale="en" dictionary={en} />)

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "System" })).toBeEnabled()
    )
    expect(screen.getByRole("group", { name: "Appearance" })).toBeVisible()
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute(
      "data-pressed"
    )

    await user.click(screen.getByRole("button", { name: "Light" }))
    expect(setTheme).toHaveBeenCalledWith("light")

    await user.click(screen.getByRole("button", { name: "Dark" }))
    expect(setTheme).toHaveBeenCalledWith("dark")
  })

  it("switches locale while preserving path, query, and hash", async () => {
    const user = userEvent.setup()
    pathname = "/agent-aster/thread-market"
    window.history.replaceState(
      {},
      "",
      "/agent-aster/thread-market?view=compact#thread-market"
    )
    render(<WorkspacePreferences locale="en" dictionary={en} />)

    const localeButton = screen.getByRole("button", {
      name: "Switch to Hebrew",
    })
    expect(localeButton).toHaveTextContent("עב")
    expect(localeButton).toHaveAttribute("lang", "he")
    expect(localeButton).toHaveAttribute("dir", "rtl")

    await user.click(localeButton)
    expect(document.cookie).toContain("aos-ui-locale=he")
    expect(window.location.pathname).toBe("/agent-aster/thread-market")
    expect(window.location.search).toBe("?view=compact")
    expect(window.location.hash).toBe("#thread-market")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("isolates the English language label inside an RTL workspace", () => {
    pathname = "/agent-aster"
    render(<WorkspacePreferences locale="he" dictionary={he} />)

    const localeButton = screen.getByRole("button", {
      name: "מעבר לאנגלית",
    })
    expect(localeButton).toHaveTextContent("EN")
    expect(localeButton).toHaveAttribute("lang", "en")
    expect(localeButton).toHaveAttribute("dir", "ltr")
  })
})
