"use client"

import { useEffect, useRef, useState, type RefObject } from "react"

import { Button } from "@/components/ui/button"

import { nextPlaybackRate } from "@shared/playback-rate"

/** Plays `element` at `rate`; a reload keeps the default speed, so set both. */
function playAt(element: HTMLMediaElement, rate: number) {
  element.defaultPlaybackRate = rate
  element.playbackRate = rate
}

/**
 * A button that steps `media` through the playback speeds, showing the
 * current one; a speed set from the native controls shows here too.
 */
function SpeedButton({
  media,
  label,
}: {
  media: RefObject<HTMLMediaElement | null>
  label: string
}) {
  const [rate, setRate] = useState(1)
  useEffect(() => {
    const element = media.current
    if (!element) return
    const follow = () => setRate(element.playbackRate)
    element.addEventListener("ratechange", follow)
    return () => element.removeEventListener("ratechange", follow)
  }, [media])
  const shown = `${rate}×`
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="ms-auto tabular-nums [@media(pointer:coarse)]:min-h-11"
      aria-label={`${label}: ${shown}`}
      onClick={() => {
        if (media.current) playAt(media.current, nextPlaybackRate(rate))
      }}
    >
      {shown}
    </Button>
  )
}

/** An attachment's native player, labelled `label`, with a speed button. */
export function MediaPlayer({
  kind,
  src,
  label,
  speedLabel,
}: {
  kind: "audio" | "video"
  src: string | undefined
  label: string
  speedLabel: string
}) {
  const media = useRef<HTMLMediaElement>(null)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {kind === "audio" ? (
        <audio
          ref={(element) => {
            media.current = element
          }}
          aria-label={label}
          className="block min-w-0 flex-1"
          controls
          preload="metadata"
          src={src}
        />
      ) : (
        <video
          ref={(element) => {
            media.current = element
          }}
          aria-label={label}
          className="block h-auto max-h-96 w-full rounded-lg bg-black object-contain"
          controls
          preload="metadata"
          src={src}
        />
      )}
      <SpeedButton media={media} label={speedLabel} />
    </div>
  )
}
