"use client"

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react"
import { useEffect, useRef, type PropsWithChildren } from "react"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ComposerSend,
  ComposerVoice,
  ComposerVoiceButton,
} from "../elements/composer-voice"
import { TooltipIconButton } from "../elements/tooltip-icon-button"
import { MicModeButton } from "./mic-mode-button"
import {
  useVoiceCaptureActive,
  useVoiceContext,
  useVoiceLabels,
  useVoiceMicLevels,
  useVoiceState,
} from "./voice-context"
import { canAttemptSpeech, waitForCommittedTranscript } from "./voice-media"

function useRecordingReason() {
  const media = useVoiceContext()?.media
  const labels = useVoiceLabels()
  const availability = useVoiceState((s) => s?.availability)
  const mode = useVoiceState((s) => s?.mode)
  const safelyIdle = useVoiceState((s) => s?.safelyIdle)
  const unavailableThread = useAuiState(
    (s) => s.thread.isDisabled || s.thread.isLoading
  )
  const hasDraft = useAuiState((s) =>
    Boolean(
      s.composer.text.trim() ||
      s.composer.attachments.length ||
      s.composer.queue.length
    )
  )
  if (!media) return undefined
  if (availability?.transcription === "loading") return labels.loading
  if (availability?.transcription === "unconfigured")
    return labels.configureTranscription
  if (!canAttemptSpeech(availability?.transcription) || unavailableThread)
    return labels.unavailable
  if (!media.recordingSupported) return labels.browser
  if (mode === "voice-turn") {
    if (!canAttemptSpeech(availability?.speech)) return labels.voiceNeedsBoth
    if (!safelyIdle) return labels.idleRequired
    if (hasDraft) return labels.emptyRequired
  }
  return undefined
}

export function VoiceComposerField({ children }: PropsWithChildren) {
  const capture = useVoiceState((s) => s?.capture)
  const levels = useVoiceMicLevels()
  const labels = useVoiceLabels()
  const root = useRef<HTMLDivElement>(null)
  const active = Boolean(
    capture && ["starting", "recording", "transcribing"].includes(capture.phase)
  )
  const dictating = useAuiState((s) => s.composer.dictation != null)
  const wasActive = useRef(false)
  useEffect(() => {
    if (active) wasActive.current = true
    // The media state may settle before AUI removes inputDisabled. Wait for both.
    if (wasActive.current && !active && !dictating) {
      if (document.visibilityState !== "hidden")
        root.current
          ?.querySelector<HTMLTextAreaElement>(
            "textarea:not([aria-hidden=true])"
          )
          ?.focus({ preventScroll: true })
      wasActive.current = false
    }
  }, [active, dictating])
  return (
    <div ref={root} className="contents">
      <div className={active ? "hidden" : "contents"}>{children}</div>
      {active && capture ? (
        <ComposerVoice
          recording={capture.phase === "recording"}
          seconds={capture.seconds}
          levels={levels}
          transcribingLabel={
            capture.phase === "starting" ? labels.starting : labels.transcribing
          }
          role="status"
          aria-label={
            capture.phase === "recording" ? labels.recording : undefined
          }
          className="min-w-0 flex-1 @min-[64rem]/workspace:w-full"
        />
      ) : null}
    </div>
  )
}

export function VoiceComposerControl() {
  const aui = useAui()
  const media = useVoiceContext()?.media
  const hasDictation = useAuiState((s) => s.thread.capabilities.dictation)
  const labels = useVoiceLabels()
  const capture = useVoiceState((s) => s?.capture)
  const mode = useVoiceState((s) => s?.mode ?? "transcription")
  const retryAvailable = useVoiceState((s) => s?.retryAvailable)
  const active = useVoiceCaptureActive()
  const reason = useRecordingReason()
  const draft = useRef("")
  const finishing = useRef(false)
  const completionButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (capture?.phase === "recording")
      completionButton.current?.focus({ preventScroll: true })
  }, [capture?.phase])
  if (!media || !hasDictation) return null

  const start = () => {
    // Recheck live state at the gesture boundary, not only the last render.
    const state = aui.composer.getState()
    if (
      media.getSnapshot().mode === "voice-turn" &&
      (!media.getSnapshot().safelyIdle ||
        state.text.trim() ||
        state.attachments.length ||
        state.queue.length)
    )
      return
    draft.current = state.text
    try {
      aui.composer.startDictation()
    } catch {
      media.cancelCapture()
    }
  }
  const discard = () => {
    media.cancelCapture()
    aui.composer.setText(draft.current)
  }
  const finish = async () => {
    if (finishing.current) return
    finishing.current = true
    const signal = media.captureSignal
    const shouldSend = mode === "voice-turn"
    try {
      const result = await media.finishCapture()
      if (!result || signal.aborted) return
      const expected =
        draft.current +
        (draft.current && !draft.current.endsWith(" ") ? " " : "") +
        result.transcript
      const committed = await waitForCommittedTranscript(
        { getState: () => aui.composer.getState(), subscribe: aui.subscribe },
        expected,
        signal
      )
      if (
        !committed ||
        !shouldSend ||
        result.reviewOnly ||
        media.captureOperation !== result.operation ||
        document.visibilityState === "hidden"
      )
        return
      const state = aui.composer.getState()
      if (
        state.attachments.length ||
        state.queue.length ||
        aui.thread.getState().isRunning
      )
        return
      media.submitVoiceTurn(
        aui.thread.getState().messages.map((message) => message.id),
        () => aui.composer.send()
      )
    } finally {
      finishing.current = false
    }
  }

  if (active)
    return (
      <>
        <TooltipIconButton
          tooltip={labels.discard}
          aria-label={labels.discard}
          type="button"
          className="size-11 shrink-0 @min-[64rem]/workspace:size-8"
          onClick={discard}
        >
          <XIcon />
        </TooltipIconButton>
        {capture?.phase === "error" ? (
          retryAvailable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (media.prepareRetry()) {
                  draft.current = aui.composer.getState().text
                  aui.composer.startDictation()
                }
              }}
            >
              {labels.retry}
            </Button>
          ) : null
        ) : (
          <ComposerPrimitive.StopDictation
            ref={completionButton}
            disabled={capture?.phase !== "recording"}
            onClick={() => void finish()}
            aria-label={mode === "voice-turn" ? labels.send : labels.finish}
            render={
              mode === "voice-turn" ? (
                <ComposerSend
                  streaming={false}
                  idle={false}
                  className="size-11 shrink-0 @min-[64rem]/workspace:size-8"
                />
              ) : (
                <ComposerVoiceButton
                  active
                  className="size-11 shrink-0 @min-[64rem]/workspace:size-8"
                />
              )
            }
          />
        )}
      </>
    )
  return (
    <MicModeButton
      mode={mode}
      onModeChange={(value) => media.setMode(value)}
      onRecord={start}
      reason={reason}
      labels={labels}
    />
  )
}

export function VoiceComposerNotice() {
  const capture = useVoiceState((s) => s?.capture)
  const playbackError = useVoiceState((s) => s?.playbackError)
  const labels = useVoiceLabels()
  const text = capture?.error
    ? labels.errors[capture.error]
    : playbackError
      ? labels.speechError
      : capture?.reviewOnly && capture.phase === "idle"
        ? labels.limit
        : undefined
  if (!text) return null
  return (
    <p
      role={capture?.error || playbackError ? "alert" : "status"}
      className="px-2 pt-1 text-xs text-muted-foreground @min-[64rem]/workspace:mx-auto @min-[64rem]/workspace:w-full @min-[64rem]/workspace:max-w-(--thread-content-max-width)"
    >
      {text}
    </p>
  )
}
