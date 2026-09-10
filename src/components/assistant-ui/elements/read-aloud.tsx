"use client"

// Upstream ReadAloud, with localized labels/touch targets. See ../voice/UPSTREAM.md.
import type { ComponentProps } from "react"
import {
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  announced,
  field,
  ghostButton,
  mono,
  paper,
  pct,
} from "./voice-surfaces"

export type ReadAloudLabels = {
  play: string
  pause: string
  loading: string
  progress: string
  time: (elapsed: string, duration: string) => string
  speed: (rate: number) => string
}
const DEFAULT_LABELS: ReadAloudLabels = {
  play: "Play",
  pause: "Pause",
  loading: "Generating audio",
  progress: "Read aloud progress",
  time: (elapsed, duration) => `${elapsed} of ${duration}`,
  speed: (rate) => `Playback speed, currently ${rate} times`,
}

export function ReadAloud({
  words,
  spokenIndex,
  playing,
  loading = false,
  rate,
  elapsed,
  duration,
  progress,
  elapsedSeconds,
  durationSeconds,
  onToggle,
  onRateChange,
  onSeek,
  labels = DEFAULT_LABELS,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  words: readonly string[]
  spokenIndex: number
  playing: boolean
  loading?: boolean
  rate: number
  elapsed: string
  duration: string
  progress?: number
  elapsedSeconds?: number
  durationSeconds?: number
  onToggle?: () => void
  onRateChange?: () => void
  onSeek?: (seconds: number) => void
  labels?: ReadAloudLabels
}) {
  const progressValue =
    progress === undefined ? pct(spokenIndex, words.length) : pct(progress, 100)
  const seekable = Boolean(
    !loading &&
    onSeek &&
    Number.isFinite(durationSeconds) &&
    (durationSeconds ?? 0) > 0
  )
  const seek = (value: number) => {
    if (!seekable || !onSeek || !durationSeconds) return
    onSeek(Math.min(durationSeconds, Math.max(0, value)))
  }
  return (
    <div
      data-slot="read-aloud"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-3.5",
        className
      )}
      {...props}
    >
      <p className="text-[13.5px] leading-relaxed">
        {words.map((word, i) => (
          <span
            key={`${i}-${word}`}
            className={cn(
              "transition-colors duration-200 motion-reduce:transition-none",
              i < spokenIndex
                ? "text-foreground/40"
                : i === spokenIndex
                  ? "rounded bg-blue-500/12 text-foreground/95 dark:bg-blue-400/15"
                  : "text-foreground/70"
            )}
          >
            {word}{" "}
          </span>
        ))}
      </p>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label={
            loading ? labels.loading : playing ? labels.pause : labels.play
          }
          disabled={loading}
          onClick={onToggle}
          className={cn(
            ghostButton,
            "size-11 shrink-0 bg-foreground/[0.06] disabled:cursor-wait disabled:opacity-70 @min-[64rem]/workspace:size-8"
          )}
        >
          {loading ? (
            <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : playing ? (
            <PauseIcon className="size-3.5" />
          ) : (
            <PlayIcon className="size-3.5 translate-x-px" />
          )}
        </button>
        <span
          role={seekable ? "slider" : "progressbar"}
          aria-label={labels.progress}
          aria-valuemin={0}
          aria-valuemax={seekable ? durationSeconds : 100}
          aria-valuenow={announced(
            seekable ? (elapsedSeconds ?? 0) : progressValue
          )}
          aria-valuetext={labels.time(elapsed, duration)}
          tabIndex={seekable ? 0 : undefined}
          onPointerDown={(event) => {
            if (!seekable) return
            const bounds = event.currentTarget.getBoundingClientRect()
            if (bounds.width > 0)
              seek(
                ((event.clientX - bounds.left) / bounds.width) *
                  (durationSeconds ?? 0)
              )
          }}
          onKeyDown={(event) => {
            if (!seekable) return
            const current = elapsedSeconds ?? 0
            if (event.key === "ArrowLeft" || event.key === "ArrowDown")
              seek(current - 5)
            else if (event.key === "ArrowRight" || event.key === "ArrowUp")
              seek(current + 5)
            else if (event.key === "Home") seek(0)
            else if (event.key === "End") seek(durationSeconds ?? 0)
            else return
            event.preventDefault()
          }}
          className={cn(
            "flex h-11 min-w-0 flex-1 items-center rounded-full",
            seekable &&
              "cursor-pointer touch-none focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:outline-none"
          )}
        >
          <span className="h-[3px] w-full overflow-hidden rounded-full bg-foreground/[0.08]">
            <span
              className="block h-full rounded-full bg-blue-500 transition-[width] duration-200 ease-linear motion-reduce:transition-none dark:bg-blue-400"
              style={{ width: `${progressValue}%` }}
            />
          </span>
        </span>
        <span
          dir="ltr"
          className={cn(mono, "shrink-0 text-foreground/35 tabular-nums")}
        >
          {elapsed} / {duration}
        </span>
        <button
          type="button"
          aria-label={labels.speed(rate)}
          onClick={onRateChange}
          className={cn(
            field,
            mono,
            "min-h-11 shrink-0 rounded-full px-2 py-1 text-foreground/55 tabular-nums transition-colors hover:text-foreground/90 @min-[64rem]/workspace:min-h-0"
          )}
        >
          {rate}×
        </button>
        <Volume2Icon
          aria-hidden
          className="size-3.5 shrink-0 text-foreground/25"
        />
      </div>
    </div>
  )
}
