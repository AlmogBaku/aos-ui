import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MicModeButton } from "./mic-mode-button"
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
      <MicModeButton
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

describe("single microphone mode button", () => {
  it("exposes a single operable recording control", () => {
    const { mic } = setup()

    expect(mic).toBeEnabled()
    expect(mic).toHaveAccessibleName(/Record:/)
  })
  it("records on tap without opening a selector", () => {
    const h = setup()
    fireEvent.click(h.mic)
    expect(h.onRecord).toHaveBeenCalledOnce()
    expect(screen.queryByRole("menu")).toBeNull()
  })
  it("uses distinct accessible labels for the recording modes", () => {
    const transcription = setup()
    expect(transcription.mic).toHaveAccessibleName(/Record:/)
    expect(transcription.mic).toHaveAccessibleDescription(
      "Press to record. Hold to switch mode."
    )
    cleanup()
    const voiceTurn = setup(undefined, "voice-turn")
    expect(voiceTurn.mic).toHaveAccessibleName(/Record:/)
  })
  it("toggles mode after a pointer hold without recording or opening a selector", async () => {
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
    fireEvent.pointerUp(h.mic, { pointerId: 1, pointerType: "touch" })
    fireEvent.click(h.mic)
    expect(h.onRecord).not.toHaveBeenCalled()
    expect(h.onModeChange).toHaveBeenCalledWith("voice-turn")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("uses the same hold gesture from the keyboard", async () => {
    vi.useFakeTimers()
    const h = setup()
    fireEvent.keyDown(h.mic, { key: " " })
    await act(() => vi.advanceTimersByTimeAsync(450))
    fireEvent.keyUp(h.mic, { key: " " })

    expect(h.onModeChange).toHaveBeenCalledWith("voice-turn")
    expect(h.onRecord).not.toHaveBeenCalled()
    expect(screen.queryByRole("menu")).toBeNull()
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
