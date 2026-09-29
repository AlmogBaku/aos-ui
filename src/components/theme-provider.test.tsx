import { cleanup, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ThemeProvider } from "./theme-provider"

const setTheme = vi.fn()

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({ resolvedTheme: "dark", setTheme }),
}))

afterEach(() => {
  cleanup()
  setTheme.mockReset()
})

describe("ThemeProvider", () => {
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
