import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { HermesAosUiApp } from "./composition"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"

const mocks = vi.hoisted(() => ({
  featureConfig: undefined as ComposerFeatureConfig | undefined,
  workspaceFeatures: undefined as ComposerFeatureViewModel | undefined,
  features: { context: { usedTokens: 17, maxTokens: 100 } },
  options: {} as {
    onError?: (error: Error) => void
    onRecovered?: () => void
  },
  bundle: {
    client: {},
    assistantRuntime: {},
    workspace: {},
    media: undefined as VoiceMediaController | undefined,
  },
}))
vi.mock("./use-hermes-composer-features", () => ({
  useHermesComposerFeatures: (
    _client: unknown,
    _runtime: unknown,
    config: ComposerFeatureConfig | undefined
  ) => {
    mocks.featureConfig = config
    return mocks.features
  },
}))
vi.mock("@/runtime-adapters/hermes", () => ({
  useHermesRuntimeBundle: (options: typeof mocks.options) => {
    mocks.options = options
    return mocks.bundle
  },
  stopCurrentHermesRun: vi.fn(),
}))
vi.mock("@/components/aos-ui-workspace", () => ({
  AosUiWorkspace: ({
    composerFeatures,
  }: {
    composerFeatures?: ComposerFeatureViewModel
  }) => {
    mocks.workspaceFeatures = composerFeatures
    return <main>Workspace remains available</main>
  },
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function showApp(locale: "en" | "he" = "en") {
  mocks.bundle.media = new VoiceMediaController()
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
  it("passes independent composer flags and the provider view model to the workspace", () => {
    mocks.bundle.media = new VoiceMediaController()
    const config = { modelSelectorEnabled: false, contextEnabled: true }
    render(
      <HermesAosUiApp
        locale="en"
        dictionary={en}
        baseUrl="/hermes"
        nowIso="2026-09-08T12:00:00Z"
        composerFeatures={config}
      />
    )
    expect(mocks.featureConfig).toEqual(config)
    expect(mocks.workspaceFeatures).toBe(mocks.features)
  })

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
