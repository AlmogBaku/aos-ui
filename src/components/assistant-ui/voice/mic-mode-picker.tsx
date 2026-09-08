"use client"

import { Popover } from "@base-ui/react/popover"
import { CheckIcon, MicIcon, RadioIcon } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { TooltipIconButton } from "../elements/tooltip-icon-button"
import { cn } from "@/lib/utils"
import type { VoiceMode } from "./voice-media"
import type { VoiceLabels } from "./voice-labels"

export function MicModePicker({
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
  const [open, setOpen] = useState(false)
  const mic = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const origin = useRef<{ x: number; y: number } | undefined>(undefined)
  const suppressClick = useRef(false)
  const id = useId()
  const clearPress = () => {
    clearTimeout(timer.current)
    timer.current = undefined
    origin.current = undefined
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const modeLabel =
    mode === "transcription" ? labels.transcription : labels.voiceTurn

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // Touch release after a long press is an outside press, not dismissal.
        if (
          !next &&
          details.reason === "outside-press" &&
          suppressClick.current &&
          details.event.target instanceof Node &&
          mic.current?.contains(details.event.target)
        ) {
          details.cancel()
          return
        }
        setOpen(next)
      }}
    >
      <TooltipIconButton
        ref={mic}
        type="button"
        tooltip={reason ?? `${modeLabel}. ${labels.modeHint}`}
        className={cn(
          "aui-composer-dictate absolute end-[calc(100%+0.25rem)] top-[calc(50%+0.25rem)] z-10 size-11 shrink-0 -translate-y-1/2 rounded-full @min-[64rem]/workspace:static @min-[64rem]/workspace:size-8 @min-[64rem]/workspace:translate-y-0",
          reason && "opacity-50"
        )}
        aria-label={`${labels.record}: ${modeLabel}`}
        aria-description={
          reason ? `${reason} ${labels.modeHint}` : labels.modeHint
        }
        aria-disabled={Boolean(reason)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false) return
          clearPress()
          suppressClick.current = false
          origin.current = { x: event.clientX, y: event.clientY }
          timer.current = setTimeout(() => {
            suppressClick.current = true
            setOpen(true)
          }, 450)
        }}
        onPointerMove={(event) => {
          const start = origin.current
          if (
            start &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
          ) {
            clearPress()
            suppressClick.current = true
          }
        }}
        onPointerUp={clearPress}
        onPointerCancel={() => {
          clearPress()
          suppressClick.current = true
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          clearPress()
          suppressClick.current = true
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowDown" ||
            (event.key === "F10" && event.shiftKey)
          ) {
            event.preventDefault()
            event.stopPropagation()
            clearPress()
            setOpen(true)
          }
        }}
        onClick={(event) => {
          event.preventDefault()
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          if (open) {
            setOpen(false)
            return
          }
          if (!reason) onRecord()
        }}
      >
        {mode === "voice-turn" ? <RadioIcon /> : <MicIcon />}
      </TooltipIconButton>
      <Popover.Portal>
        <Popover.Positioner
          anchor={mic}
          side="top"
          align="end"
          sideOffset={8}
          className="isolate z-50"
        >
          <Popover.Popup
            finalFocus={mic}
            className="rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none"
          >
            <Popover.Title className="sr-only">
              {labels.modePicker}
            </Popover.Title>
            {reason ? (
              <Popover.Description className="max-w-64 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                {reason}
              </Popover.Description>
            ) : null}
            <div
              id={id}
              ref={menu}
              role="menu"
              aria-label={labels.modePicker}
              onKeyDown={(event) => {
                if (
                  !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
                )
                  return
                event.preventDefault()
                const items = Array.from(
                  menu.current?.querySelectorAll<HTMLButtonElement>("button") ??
                    []
                )
                const current = items.indexOf(
                  document.activeElement as HTMLButtonElement
                )
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (current +
                          (event.key === "ArrowUp" ? -1 : 1) +
                          items.length) %
                        items.length
                items[next]?.focus()
              }}
            >
              {(["transcription", "voice-turn"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === value}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                  onClick={() => {
                    onModeChange(value)
                    setOpen(false)
                  }}
                >
                  <span className="flex-1">
                    {value === "transcription"
                      ? labels.transcription
                      : labels.voiceTurn}
                  </span>
                  <CheckIcon
                    aria-hidden
                    className={cn("size-4", mode !== value && "invisible")}
                  />
                </button>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
