import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MicModePicker } from "./mic-mode-picker"
import { voiceLabels } from "./voice-labels"
import { TooltipProvider } from "@/components/ui/tooltip"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function setup(
  reason?: string,
  mode: "transcription" | "voice-turn" = "transcription"
) {
  const onRecord = vi.fn()
  const onModeChange = vi.fn()
  render(
    <TooltipProvider>
      <MicModePicker
        mode={mode}
        onRecord={onRecord}
        onModeChange={onModeChange}
        reason={reason}
        labels={voiceLabels.en}
      />
    </TooltipProvider>
  )
  return {
    onRecord,
    onModeChange,
    mic: screen.getByRole("button", { name: /Record/ }),
  }
}

describe("single microphone mode picker", () => {
  it("stays in the composer rail so it cannot cover adjacent controls", () => {
    const { mic } = setup()

    expect(mic).not.toHaveClass("absolute")
  })
  it("records on tap without opening a selector", () => {
    const h = setup()
    fireEvent.click(h.mic)
    expect(h.onRecord).toHaveBeenCalledOnce()
    expect(screen.queryByRole("menu")).toBeNull()
  })
  it("uses a distinct radio glyph for voice-turn mode", () => {
    const transcription = setup()
    expect(transcription.mic.querySelector(".lucide-mic")).not.toBeNull()
    cleanup()
    const voiceTurn = setup(undefined, "voice-turn")
    expect(voiceTurn.mic.querySelector(".lucide-radio")).not.toBeNull()
    expect(voiceTurn.mic.querySelector(".lucide-mic")).toBeNull()
  })
  it("opens at 450ms, consumes release and selects a mode without recording", async () => {
    vi.useFakeTimers()
    const h = setup()
    fireEvent.pointerDown(h.mic, {
      button: 0,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    })
    await act(() => vi.advanceTimersByTimeAsync(449))
    expect(screen.queryByRole("menu")).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByRole("menu")).toBeInTheDocument()
    fireEvent.pointerUp(h.mic, { pointerId: 1, pointerType: "touch" })
    fireEvent.click(h.mic)
    expect(h.onRecord).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Voice turn" }))
    expect(h.onModeChange).toHaveBeenCalledWith("voice-turn")
  })
  it.each([{ key: "ArrowDown" }, { key: "F10", shiftKey: true }])(
    "opens with the keyboard even when recording is unavailable: %j",
    async (key) => {
      const h = setup("Finish the current run first")
      h.mic.focus()
      fireEvent.keyDown(h.mic, key)
      expect(await screen.findByRole("menu")).toBeVisible()
      fireEvent.keyDown(
        screen.getByRole("menuitemradio", { name: "Transcription" }),
        { key: "Escape" }
      )
      await vi.waitFor(() => expect(h.mic).toHaveFocus())
      expect(h.onRecord).not.toHaveBeenCalled()
    }
  )
  it("shows the blocked recording reason inside the touch-accessible picker", async () => {
    vi.useFakeTimers()
    const h = setup("Finish the current run first")
    fireEvent.pointerDown(h.mic, {
      button: 0,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    })
    await act(() => vi.advanceTimersByTimeAsync(450))
    expect(screen.getByRole("menu").parentElement).toHaveTextContent(
      "Finish the current run first"
    )
    expect(h.onRecord).not.toHaveBeenCalled()
  })
  it("cancels a moved or cancelled press", async () => {
    vi.useFakeTimers()
    const h = setup()
    fireEvent.pointerDown(h.mic, {
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      isPrimary: true,
    })
    fireEvent.pointerMove(h.mic, { pointerId: 1, clientX: 30, clientY: 0 })
    await act(() => vi.advanceTimersByTimeAsync(500))
    fireEvent.pointerCancel(h.mic, { pointerId: 1 })
    fireEvent.click(h.mic)
    expect(h.onRecord).not.toHaveBeenCalled()
    expect(screen.queryByRole("menu")).toBeNull()
  })
})
