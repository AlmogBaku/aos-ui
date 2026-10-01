import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { cn } from "../ui/cn"

/** The speeds the speed button steps through, in order. */
const RATES: readonly number[] = [1, 1.25, 1.5, 2]

/**
 * A file's native player, labelled `label`, playing straight from `src`, which
 * answers byte ranges, so the file streams and seeks rather than being read
 * whole. A renewed `src` plays on from where the old one was. Beside it, a
 * button steps through the playback speeds and shows the current one. With
 * `fill`, a video fills the height it is given; otherwise it is at most a
 * modest height.
 */
export function MediaPlayer({
  kind,
  src,
  label,
  speedLabel,
  fill = false,
}: {
  kind: "audio" | "video"
  src: string
  label: string
  speedLabel: string
  fill?: boolean
}) {
  const media = useRef<HTMLMediaElement | null>(null)
  const playing = useRef<string | undefined>(undefined)
  const [rate, setRate] = useState(1)

  useLayoutEffect(() => {
    const element = media.current!
    const renewed = playing.current !== undefined
    playing.current = src
    if (!renewed) {
      element.src = src
      return
    }
    const { currentTime, paused } = element
    element.src = src
    const resume = () => {
      element.currentTime = currentTime
      if (!paused) void element.play().catch(() => undefined)
    }
    element.addEventListener("loadedmetadata", resume, { once: true })
    return () => element.removeEventListener("loadedmetadata", resume)
  }, [src])

  // A speed set from the native controls shows on the button too.
  useEffect(() => {
    const element = media.current!
    const follow = () => setRate(element.playbackRate)
    element.addEventListener("ratechange", follow)
    return () => element.removeEventListener("ratechange", follow)
  }, [])

  const attach = (element: HTMLMediaElement | null) => {
    media.current = element
  }
  const shown = `${rate}×`
  return (
    <div
      className={cn(
        "flex gap-2",
        fill ? "min-h-0 flex-1 flex-col" : "flex-wrap items-center"
      )}
    >
      {kind === "audio" ? (
        <audio
          ref={attach}
          aria-label={label}
          className="block min-w-0 flex-1"
          controls
          preload="metadata"
        />
      ) : (
        <video
          ref={attach}
          aria-label={label}
          className={cn(
            "block w-full rounded-lg bg-black object-contain",
            fill ? "min-h-0 flex-1" : "h-auto max-h-64"
          )}
          controls
          playsInline
          preload="metadata"
        />
      )}
      <button
        type="button"
        aria-label={`${speedLabel}: ${shown}`}
        className="ms-auto inline-flex h-8 min-w-12 shrink-0 cursor-pointer items-center justify-center self-end rounded-md px-2 text-xs font-medium tabular-nums outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(pointer:coarse)]:h-11"
        onClick={() => {
          const element = media.current!
          const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]!
          // A reload starts at the default speed, so both are set.
          element.defaultPlaybackRate = next
          element.playbackRate = next
        }}
      >
        {shown}
      </button>
    </div>
  )
}
