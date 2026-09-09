"use client"

import { ActionBarPrimitive, useAui, useAuiState } from "@assistant-ui/react"
import { useEffect, useRef } from "react"
import { SquareIcon, Volume2Icon } from "lucide-react"
import { ReadAloud } from "../elements/read-aloud"
import { TooltipIconButton } from "../elements/tooltip-icon-button"
import {
  useVoiceCaptureActive,
  useVoiceContext,
  useVoiceLabels,
  useVoiceState,
} from "./voice-context"
import { canAttemptSpeech, type VoiceAutoReadRequest } from "./voice-media"

/** Resolve a one-shot PTT intent from the owning Assistant UI thread. */
export function VoiceReplyReader() {
  const aui = useAui()
  const media = useVoiceContext()?.media
  const request = useVoiceState((s) => s?.readRequest)
  const autoRead = useVoiceState((s) => s?.autoReadRequest)
  const messages = useAuiState((s) => s.thread.messages)
  const running = useAuiState((s) => s.thread.isRunning)
  const queued = useAuiState((s) => s.composer.queue.length)
  const playbackOwner = useVoiceState((s) => s?.playbackOwner)
  const playbackOwnerId = playbackOwner?.messageId
  const autoReadRun = useRef<{
    request?: VoiceAutoReadRequest
    sawRunning: boolean
  }>({ sawRunning: false })
  useEffect(() => {
    if (
      media &&
      playbackOwner?.scopeId === media.getSnapshot().scopeId &&
      playbackOwnerId &&
      !media.isPlaybackOwnerPresent(messages.map((message) => message.id))
    )
      media.stopSpeech()
  }, [media, messages, playbackOwner, playbackOwnerId])
  useEffect(() => {
    if (!media || !autoRead) {
      autoReadRun.current = { sawRunning: false }
      return
    }
    if (autoReadRun.current.request !== autoRead)
      autoReadRun.current = { request: autoRead, sawRunning: false }
    if (queued > 0) {
      media.clearAutoRead(autoRead)
      return
    }
    const baseline = new Set(autoRead.baselineMessageIds)
    const added = messages.filter((message) => !baseline.has(message.id))
    const userIndexes = added.flatMap((message, index) =>
      message.role === "user" ? [index] : []
    )
    if (userIndexes.length > 1) {
      media.clearAutoRead(autoRead)
      return
    }
    if (running) {
      autoReadRun.current.sawRunning = true
      return
    }
    const replies = added.slice((userIndexes[0] ?? added.length) + 1)
    const candidate = replies.findLast(
      (message) =>
        message.role === "assistant" &&
        message.status?.type === "complete" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => part.type === "text" && part.text.trim().length > 0
        )
    )
    if (candidate) media.resolveAutoRead(autoRead, candidate.id)
    else if (
      autoReadRun.current.sawRunning ||
      replies.some((message) => message.role === "assistant")
    )
      media.clearAutoRead(autoRead)
  }, [autoRead, media, messages, queued, running])
  useEffect(() => {
    if (!media || !request || running) return
    const message = messages.find((item) => item.id === request.messageId)
    if (
      !message ||
      message.role !== "assistant" ||
      message.status?.type !== "complete"
    )
      return
    if (!media.consumeReadRequest(request)) return
    if (
      document.visibilityState === "hidden" ||
      media.captureActive ||
      !aui.thread.getState().capabilities.speech
    )
      return
    try {
      media.preparePlaybackOwner(
        message.id,
        messages.findIndex((item) => item.id === message.id)
      )
      aui.thread.message({ id: message.id }).speak()
    } catch {
      /* No automatic retry of a stale command. Manual Speak remains available. */
    }
  }, [aui, media, messages, request, running])
  return null
}

export function useVoiceMessageReading() {
  const voice = useVoiceContext()
  const runtimeReading = useAuiState((s) => Boolean(s.message.speech))
  const messageId = useAuiState((s) => s.message.id)
  const owner = useVoiceState((s) => s?.playbackOwner)
  if (!voice) return false
  return Boolean(
    runtimeReading ||
    (owner &&
      owner.scopeId === voice.media.getSnapshot().scopeId &&
      owner.messageId === messageId)
  )
}

function time(seconds: number) {
  const value = Math.max(0, Math.floor(seconds))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`
}

export function InlineReadAloud() {
  const media = useVoiceContext()?.media
  const playback = useVoiceState((s) => s?.playback)
  const labels = useVoiceLabels()
  const reading = useVoiceMessageReading()
  if (!media || !playback || !reading) return null
  return (
    <div data-slot="aui_message-read-aloud">
      <ReadAloud
        role="group"
        aria-label={labels.readAloud}
        aria-busy={playback.loading}
        words={playback.text.split(/\s+/u).filter(Boolean)}
        spokenIndex={-1}
        playing={playback.playing}
        loading={playback.loading}
        elapsed={time(playback.elapsed)}
        duration={time(playback.duration)}
        rate={playback.rate}
        labels={labels.playback}
        onToggle={() => void media.togglePlayback()}
        onRateChange={media.cycleRate}
        className="max-w-none"
      />
      {playback.loading || playback.blocked ? (
        <p role="status" className="pt-1 text-xs text-muted-foreground">
          {playback.loading ? labels.synthesizing : labels.autoplay}
        </p>
      ) : null}
    </div>
  )
}

export function VoiceMessageActions() {
  const aui = useAui()
  const media = useVoiceContext()?.media
  const labels = useVoiceLabels()
  const availability = useVoiceState((s) => s?.availability.speech)
  const captureActive = useVoiceCaptureActive()
  const hasCapability = useAuiState((s) => s.thread.capabilities.speech)
  const runtimeReading = useAuiState((s) => Boolean(s.message.speech))
  const reading = useVoiceMessageReading()
  const messageId = useAuiState((s) => s.message.id)
  const action = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!restoreFocus.current) return
    action.current?.focus({ preventScroll: true })
    restoreFocus.current = false
  }, [reading])
  if (!media || !hasCapability) return null
  const reason =
    availability === "loading"
      ? labels.loading
      : availability === "unconfigured"
        ? labels.configureSpeech
        : !canAttemptSpeech(availability)
          ? labels.unavailable
          : captureActive
            ? labels.recording
            : undefined
  if (reading && !runtimeReading)
    return (
      <TooltipIconButton
        ref={action}
        tooltip={labels.stopSpeaking}
        aria-label={labels.stopSpeaking}
        className="size-11 @min-[64rem]/workspace:size-6"
        onClick={() => {
          media.disarm()
          media.stopSpeech()
          restoreFocus.current = true
        }}
      >
        <SquareIcon />
      </TooltipIconButton>
    )
  if (reading)
    return (
      <ActionBarPrimitive.StopSpeaking
        onClick={() => {
          media.disarm()
          restoreFocus.current = true
        }}
        render={
          <TooltipIconButton
            ref={action}
            tooltip={labels.stopSpeaking}
            aria-label={labels.stopSpeaking}
            className="size-11 @min-[64rem]/workspace:size-6"
          />
        }
      >
        <SquareIcon />
      </ActionBarPrimitive.StopSpeaking>
    )
  return (
    <ActionBarPrimitive.Speak
      disabled={Boolean(reason)}
      onClick={(event) => {
        if (
          media.captureActive ||
          !canAttemptSpeech(media.getSnapshot().availability.speech)
        ) {
          event.preventDefault()
          return
        }
        media.disarm()
        const messages = aui.thread.getState().messages
        media.preparePlaybackOwner(
          messageId,
          messages.findIndex((message) => message.id === messageId)
        )
        restoreFocus.current = true
      }}
      render={
        <TooltipIconButton
          ref={action}
          tooltip={reason ?? labels.readAloud}
          aria-label={labels.readAloud}
          aria-description={reason}
          className="size-11 @min-[64rem]/workspace:size-6"
        />
      }
    >
      <Volume2Icon />
    </ActionBarPrimitive.Speak>
  )
}
