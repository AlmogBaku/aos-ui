import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ReadAloud } from "../elements/read-aloud"
import { ComposerVoice } from "../elements/composer-voice"

afterEach(cleanup)

it("renders upstream ReadAloud with no word highlighting and independent real time", () => {
  const toggle = vi.fn()
  const rate = vi.fn()
  const { container } = render(
    <ReadAloud
      words={["Hello", "world"]}
      spokenIndex={-1}
      playing
      rate={1.25}
      elapsed="0:12"
      duration="0:40"
      onToggle={toggle}
      onRateChange={rate}
      labels={{
        play: "ניגון",
        pause: "השהיה",
        loading: "מפיק שמע",
        progress: "התקדמות",
        time: (e, d) => `${e} מתוך ${d}`,
        speed: (value) => `מהירות ${value}`,
      }}
    />
  )
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    "0:12 מתוך 0:40"
  )
  expect(container.querySelector("p .rounded")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "השהיה" }))
  fireEvent.click(screen.getByRole("button", { name: "מהירות 1.25" }))
  expect(toggle).toHaveBeenCalledOnce()
  expect(rate).toHaveBeenCalledOnce()
})

it("shows synthesis in the play control and prevents playback until ready", () => {
  const toggle = vi.fn()
  const { container } = render(
    <ReadAloud
      words={["Preparing", "audio"]}
      spokenIndex={-1}
      playing={false}
      loading
      rate={1}
      elapsed="0:00"
      duration="0:00"
      onToggle={toggle}
    />
  )

  const play = screen.getByRole("button", { name: "Generating audio" })
  expect(play).toBeDisabled()
  expect(container.querySelector(".lucide-loader-circle")).not.toBeNull()
  fireEvent.click(play)
  expect(toggle).not.toHaveBeenCalled()
})

it("drives the supplied ComposerVoice bars from microphone levels", () => {
  const levels = [
    0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 0.8, 0.4, 0,
  ]
  const { container, rerender } = render(
    <div dir="rtl">
      <ComposerVoice
        recording
        seconds={12}
        levels={levels}
        transcribingLabel="מתמלל"
      />
    </div>
  )
  const bars = container.querySelectorAll<HTMLElement>(
    '[data-slot="composer-voice-level"]'
  )
  expect(bars).toHaveLength(14)
  expect(bars[0]).toHaveStyle({ height: "3px" })
  expect(bars[10]).toHaveStyle({ height: "18px" })
  expect(bars[0]?.parentElement).toHaveAttribute("dir", "ltr")
  expect(screen.getByText("0:12")).toBeVisible()
  rerender(
    <ComposerVoice
      recording={false}
      seconds={47}
      levels={levels}
      transcribingLabel="מתמלל"
    />
  )
  expect(screen.getByText("מתמלל")).toHaveClass("shimmer")
})
