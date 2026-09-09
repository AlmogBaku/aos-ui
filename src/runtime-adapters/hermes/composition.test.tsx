import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { HermesAosUiApp } from "./composition"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import type { HermesSession } from "./hermes-native-client"

type MockHermesSession = Pick<HermesSession, "threadId"> & {
  clarification?: Pick<
    NonNullable<HermesSession["clarification"]>,
    "requestId" | "questions"
  >
  approval?: Pick<
    NonNullable<HermesSession["approval"]>,
    "requestId" | "message" | "choices"
  >
}

const mocks = vi.hoisted(() => ({
  options: {} as {
    onError?: (error: Error) => void
    onRecovered?: () => void
  },
  bundle: {
    client: {
      subscribe: () => () => undefined,
      session: (): MockHermesSession | undefined => undefined,
    },
    assistantRuntime: {
      threads: {
        subscribe: () => () => undefined,
        getState: () => ({
          mainThreadId: "main",
          threadItems: { main: { remoteId: "thread-one" } },
        }),
      },
    },
    workspace: {},
    interactions: {
      respond: vi.fn(),
      reject: vi.fn(),
    },
    media: undefined as VoiceMediaController | undefined,
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
    composer: Composer,
  }: {
    composer?: ComponentType<{ fallback: ReactNode }>
  }) => (
    <main>
      Workspace remains available
      {Composer ? <Composer fallback={<span>Fallback composer</span>} /> : null}
    </main>
  ),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  mocks.bundle.client.session = () => undefined
  vi.mocked(mocks.bundle.interactions.respond).mockClear()
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
  it("renders a selected Session clarification only in the composer", () => {
    const session = {
      threadId: "thread-one",
      clarification: {
        requestId: "clarify-one",
        questions: [
          {
            question: "Which deployment region?",
            choices: ["IL", "US"],
            multiple: false,
          },
        ],
      },
    }
    mocks.bundle.client.session = () => session
    showApp()
    expect(screen.getByLabelText("Questions")).toBeVisible()
    expect(screen.getByText("Which deployment region?")).toBeVisible()
    expect(screen.queryByText("Fallback composer")).not.toBeInTheDocument()
  })

  it("submits the selected Session clarification through the bundle adapter", async () => {
    const session = {
      threadId: "thread-one",
      clarification: {
        requestId: "clarify-one",
        questions: [
          {
            question: "Which deployment region?",
            choices: ["IL", "US"],
            multiple: false,
          },
        ],
      },
    }
    mocks.bundle.client.session = () => session
    showApp()
    fireEvent.click(screen.getByText("IL"))
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }))
    await vi.waitFor(() =>
      expect(mocks.bundle.interactions.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "question",
          requestId: "clarify-one",
          sessionId: "thread-one",
        }),
        { kind: "question", answers: [["IL"]] }
      )
    )
  })

  it("renders every native approval scope through the shared approval composer", () => {
    const session = {
      threadId: "thread-one",
      approval: {
        requestId: "approval-one",
        message: "Use the network?",
        choices: ["once", "session", "always", "deny"] as const,
      },
    }
    mocks.bundle.client.session = () => session
    showApp()
    expect(
      screen.getByRole("button", { name: "Allow for this session" })
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "Always allow" })).toBeVisible()
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
