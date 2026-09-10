import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ReadAloud } from "../elements/read-aloud"
import { ComposerVoice } from "../elements/composer-voice"

afterEach(cleanup)

it("renders upstream ReadAloud with no word highlighting and independent real time", () => {
  const toggle = vi.fn()
  const rate = vi.fn()
  render(
    <ReadAloud
      words={["Hello", "world"]}
      spokenIndex={-1}
      playing
      rate={1.25}
      elapsed="0:12"
      duration="0:40"
      progress={30}
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
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30")
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    "0:12 מתוך 0:40"
  )
  fireEvent.click(screen.getByRole("button", { name: "השהיה" }))
  fireEvent.click(screen.getByRole("button", { name: "מהירות 1.25" }))
  expect(toggle).toHaveBeenCalledOnce()
  expect(rate).toHaveBeenCalledOnce()
})

it.each([
  [0, "0"],
  [-10, "0"],
  [125, "100"],
])("clamps supplied read-aloud progress %s to %s", (progress, expected) => {
  render(
    <ReadAloud
      words={["No", "timestamps"]}
      spokenIndex={-1}
      playing={false}
      progress={progress}
      rate={1}
      elapsed="0:00"
      duration="0:00"
    />
  )

  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    expected
  )
})

it("shows synthesis in the play control and prevents playback until ready", () => {
  const toggle = vi.fn()
  render(
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
  fireEvent.click(play)
  expect(toggle).not.toHaveBeenCalled()
})

it("keeps the timeline read-only while audio is generating", () => {
  const seek = vi.fn()
  render(
    <ReadAloud
      words={["Preparing", "audio"]}
      spokenIndex={-1}
      playing={false}
      loading
      rate={1}
      elapsed="0:00"
      duration="0:24"
      elapsedSeconds={0}
      durationSeconds={24}
      onSeek={seek}
    />
  )

  expect(screen.getByRole("progressbar")).toBeVisible()
  expect(screen.queryByRole("slider")).toBeNull()
})

it("seeks from the timeline with pointer and keyboard controls", () => {
  const seek = vi.fn()
  render(
    <ReadAloud
      words={["Seekable", "audio"]}
      spokenIndex={-1}
      playing
      progress={25}
      rate={1}
      elapsed="0:06"
      duration="0:24"
      elapsedSeconds={6}
      durationSeconds={24}
      onSeek={seek}
    />
  )

  const timeline = screen.getByRole("slider", {
    name: "Read aloud progress",
  })
  expect(timeline).toHaveAttribute("aria-valuenow", "6")
  expect(timeline).toHaveAttribute("aria-valuemax", "24")
  vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 0,
    width: 200,
    height: 3,
    top: 0,
    right: 210,
    bottom: 3,
    left: 10,
    toJSON: () => ({}),
  })
  fireEvent.pointerDown(timeline, { clientX: 160 })
  fireEvent.keyDown(timeline, { key: "ArrowRight" })
  fireEvent.keyDown(timeline, { key: "Home" })
  fireEvent.keyDown(timeline, { key: "End" })

  expect(seek).toHaveBeenNthCalledWith(1, 18)
  expect(seek).toHaveBeenNthCalledWith(2, 11)
  expect(seek).toHaveBeenNthCalledWith(3, 0)
  expect(seek).toHaveBeenNthCalledWith(4, 24)
})

it("drives the supplied ComposerVoice bars from microphone levels", () => {
  const levels = [
    0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 0.8, 0.4, 0,
  ]
  const { rerender } = render(
    <div dir="rtl">
      <ComposerVoice
        recording
        seconds={12}
        levels={levels}
        transcribingLabel="מתמלל"
      />
    </div>
  )
  expect(screen.getByText("0:12")).toBeVisible()
  rerender(
    <ComposerVoice
      recording={false}
      seconds={47}
      levels={levels}
      transcribingLabel="מתמלל"
    />
  )
  expect(screen.getByText("מתמלל")).toBeVisible()
})
