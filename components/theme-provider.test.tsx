import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ThemeProvider } from "./theme-provider"

const setTheme = vi.fn()

vi.mock("next-themes", () => ({
  ThemeProvider: ({
    attribute,
    children,
    defaultTheme,
    disableTransitionOnChange,
    enableSystem,
  }: {
    attribute?: string
    children: ReactNode
    defaultTheme?: string
    disableTransitionOnChange?: boolean
    enableSystem?: boolean
  }) => (
    <div
      data-testid="next-themes-provider"
      data-attribute={attribute}
      data-default-theme={defaultTheme}
      data-disable-transition={String(disableTransitionOnChange)}
      data-enable-system={String(enableSystem)}
    >
      {children}
    </div>
  ),
  useTheme: () => ({ resolvedTheme: "dark", setTheme }),
}))

afterEach(() => {
  cleanup()
  setTheme.mockReset()
})

describe("ThemeProvider", () => {
  it("uses the persisted system-aware class strategy by default", () => {
    render(
      <ThemeProvider>
        <span>Workspace</span>
      </ThemeProvider>
    )

    const provider = screen.getByTestId("next-themes-provider")
    expect(provider).toHaveAttribute("data-attribute", "class")
    expect(provider).toHaveAttribute("data-default-theme", "system")
    expect(provider).toHaveAttribute("data-enable-system", "true")
    expect(provider).toHaveAttribute("data-disable-transition", "true")
  })

  it("does not reserve an undocumented global keyboard shortcut", () => {
    render(
      <ThemeProvider>
        <span>Workspace</span>
      </ThemeProvider>
    )

    fireEvent.keyDown(window, { key: "d" })

    expect(setTheme).not.toHaveBeenCalled()
  })
})
