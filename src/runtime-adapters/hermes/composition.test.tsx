import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { HermesAosUiApp } from "./composition"

const mocks = vi.hoisted(() => ({
  options: {} as {
    onError?: (error: Error) => void
    onRecovered?: () => void
  },
  bundle: { client: {}, assistantRuntime: {}, workspace: {} },
}))
vi.mock("@/runtime-adapters/hermes", () => ({
  useHermesRuntimeBundle: (options: typeof mocks.options) => {
    mocks.options = options
    return mocks.bundle
  },
  stopCurrentHermesRun: vi.fn(),
}))
vi.mock("@/components/aos-ui-workspace", () => ({
  AosUiWorkspace: () => <main>Workspace remains available</main>,
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function showApp(locale: "en" | "he" = "en") {
  return render(
    <HermesAosUiApp
      locale={locale}
      dictionary={en}
      baseUrl="/hermes"
      nowIso="2026-09-08T12:00:00Z"
    />
  )
}

describe("Hermes error toasts", () => {
  it("does not auto-dismiss an unresolved error", () => {
    vi.useFakeTimers()
    showApp()
    act(() => mocks.options.onError!(new Error("Persistent failure")))
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole("alert")).toHaveTextContent("Persistent failure")
  })

  it("keeps one dismissible toast without changing runtime callback identity", () => {
    showApp()
    const onError = mocks.options.onError!
    const error = new Error("Hermes authentication failed (401)")
    act(() => onError(error))
    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-slot",
      "error-toast"
    )
    expect(screen.getByRole("main")).toBeVisible()
    expect(
      screen.getByRole("link", { name: "Sign in to Hermes" })
    ).toHaveAttribute("href", "/hermes/login")
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible()
    expect(mocks.options.onError).toBe(onError)
    act(() => onError(error))
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" })
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    act(() => onError(error))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    act(() => onError(new Error("Different failure")))
    expect(screen.getByRole("alert")).toHaveTextContent("Different failure")
  })

  it("clears connection failures after recovery but preserves unrelated operation failures", () => {
    showApp()
    act(() =>
      mocks.options.onError!(new Error("Hermes WebSocket connection failed"))
    )
    act(() => mocks.options.onRecovered!())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    act(() => mocks.options.onError!(new Error("Prompt outcome uncertain")))
    act(() => mocks.options.onRecovered!())
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Prompt outcome uncertain"
    )
  })

  it("supports Hebrew and RTL", () => {
    showApp("he")
    act(() => mocks.options.onError!(new Error("Failure")))
    expect(screen.getByRole("alert")).toHaveAttribute("dir", "rtl")
    fireEvent.click(screen.getByRole("button", { name: "סגירת הודעה" }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
