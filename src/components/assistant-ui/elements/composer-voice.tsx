"use client"

// Selective copy of upstream ComposerVoice; see ../voice/UPSTREAM.md.
import type { ComponentProps } from "react"
import { ArrowUpIcon, MicIcon, SquareIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  ghostButton,
  iconSwap,
  iconSwapIn,
  iconSwapOut,
  inkButton,
  mono,
  ShimmerLabel,
} from "./voice-surfaces"

const BARS = Array.from({ length: 14 }, (_, i) => i)

export function ComposerVoice({
  recording,
  seconds,
  levels,
  transcribingLabel = "Transcribing",
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  recording: boolean
  seconds: number
  levels?: readonly number[] | undefined
  transcribingLabel?: string
}) {
  return (
    <div
      data-slot="composer-voice"
      data-recording={recording || undefined}
      className={cn("flex min-h-11 items-center gap-3 ps-3", className)}
      {...props}
    >
      {recording && (
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
        />
      )}
      <div
        dir="ltr"
        className="flex h-6 items-center gap-[3px]"
        aria-hidden
      >
        {BARS.map((bar) => (
          <span
            key={bar}
            data-slot="composer-voice-level"
            className={cn(
              "w-0.5 rounded-full transition-colors duration-150 motion-reduce:transition-none",
              recording ? "bg-foreground/50" : "bg-foreground/25"
            )}
            style={{
              height: recording
                ? 3 + Math.min(1, Math.max(0, levels?.[bar] ?? 0)) * 15
                : 3,
            }}
          />
        ))}
      </div>
      {recording ? (
        <span dir="ltr" className={cn(mono, "text-foreground/40 tabular-nums")}>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      ) : (
        <ShimmerLabel className="relative text-[13px] text-foreground/55">
          {transcribingLabel}
        </ShimmerLabel>
      )}
    </div>
  )
}

export function ComposerVoiceButton({
  active,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { active: boolean }) {
  return (
    <button
      type="button"
      aria-label={active ? "Stop recording" : "Start voice input"}
      data-slot="composer-voice-button"
      className={cn(
        active
          ? cn(
              inkButton,
              "flex size-8 items-center justify-center rounded-full"
            )
          : cn(ghostButton, "size-8"),
        className
      )}
      {...props}
    >
      {active ? (
        <SquareIcon className="size-3 fill-current" />
      ) : (
        <MicIcon className="size-4" />
      )}
    </button>
  )
}

export function ComposerSend({
  streaming,
  idle,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  streaming: boolean
  idle: boolean
}) {
  return (
    <button
      type="button"
      aria-label={streaming ? "Stop generating" : "Send message"}
      data-slot="composer-send"
      className={cn(
        "grid size-8 place-items-center rounded-full",
        streaming || !idle
          ? inkButton
          : "bg-foreground/[0.06] text-foreground/30 transition-colors dark:bg-foreground/[0.09]",
        className
      )}
      {...props}
    >
      <ArrowUpIcon
        className={cn(iconSwap, "size-4", streaming ? iconSwapOut : iconSwapIn)}
      />
      <SquareIcon
        className={cn(
          iconSwap,
          "size-3 fill-current",
          streaming ? iconSwapIn : iconSwapOut
        )}
      />
    </button>
  )
}
