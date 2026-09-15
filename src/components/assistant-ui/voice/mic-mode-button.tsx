"use client"

import { MicIcon, RadioIcon } from "lucide-react"
import { useEffect, useRef } from "react"

import { TooltipIconButton } from "../elements/tooltip-icon-button"
import { cn } from "@/lib/utils"
import type { VoiceMode } from "./voice-media"
import type { VoiceLabels } from "./voice-labels"

const HOLD_MS = 450

export function MicModeButton({
  mode,
  onModeChange,
  onRecord,
  reason,
  labels,
}: {
  mode: VoiceMode
  onModeChange: (mode: VoiceMode) => void
  onRecord: () => void
  reason?: string | undefined
  labels: VoiceLabels
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const origin = useRef<{ x: number; y: number } | undefined>(undefined)
  const keyboardKey = useRef<" " | "Enter" | undefined>(undefined)
  const suppressClick = useRef(false)
  const modeLabel =
    mode === "transcription" ? labels.transcription : labels.voiceTurn

  const clearHold = () => {
    clearTimeout(timer.current)
    timer.current = undefined
    origin.current = undefined
  }
  const beginHold = () => {
    clearHold()
    suppressClick.current = false
    timer.current = setTimeout(() => {
      timer.current = undefined
      suppressClick.current = true
      onModeChange(mode === "transcription" ? "voice-turn" : "transcription")
    }, HOLD_MS)
  }
  const finishKeyboardPress = () => {
    if (timer.current === undefined) return
    clearHold()
    if (!reason) onRecord()
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <TooltipIconButton
      type="button"
      tooltip={reason ?? `${modeLabel}. ${labels.modeHint}`}
      className={cn(
        "aui-composer-dictate size-11 shrink-0 rounded-full @min-[64rem]/workspace:size-8",
        reason && "opacity-50"
      )}
      aria-label={`${labels.record}: ${modeLabel}`}
      aria-description={
        reason ? `${reason} ${labels.modeHint}` : labels.modeHint
      }
      aria-disabled={Boolean(reason)}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false) return
        beginHold()
        origin.current = { x: event.clientX, y: event.clientY }
      }}
      onPointerMove={(event) => {
        const start = origin.current
        if (
          start &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
        ) {
          clearHold()
          suppressClick.current = true
        }
      }}
      onPointerUp={clearHold}
      onPointerCancel={() => {
        clearHold()
        suppressClick.current = true
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (
          (event.key !== " " && event.key !== "Enter") ||
          event.repeat ||
          keyboardKey.current
        )
          return
        event.preventDefault()
        keyboardKey.current = event.key
        beginHold()
      }}
      onKeyUp={(event) => {
        if (event.key !== keyboardKey.current) return
        event.preventDefault()
        keyboardKey.current = undefined
        finishKeyboardPress()
      }}
      onBlur={() => {
        keyboardKey.current = undefined
        clearHold()
      }}
      onClick={(event) => {
        event.preventDefault()
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        if (!reason) onRecord()
      }}
    >
      {mode === "voice-turn" ? <RadioIcon /> : <MicIcon />}
    </TooltipIconButton>
  )
}
