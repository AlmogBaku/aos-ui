"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ComposerPrimitive,
  QueueItemPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { CornerDownRightIcon, LoaderCircleIcon, Trash2Icon } from "lucide-react"

import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button"
import { Button } from "@/components/ui/button"

export const STEER_ACCEPTED_DATA_NAME = "aos.steer.accepted"

export type MessageQueueLabels = {
  readonly region: string
  readonly steer: string
  readonly steerLabel: string
  readonly removeLabel: string
  readonly steering: string
  readonly failed: string
}

export type UnconfirmedDelivery = {
  readonly requestId: string
  readonly text: string
}

function queueItemText(
  parts: readonly { type: string; text?: string | undefined }[]
) {
  return parts
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : []
    )
    .join("\n\n")
}

export function isUncertainDelivery(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { code?: unknown; kind?: unknown }
  return (
    value.code === "uncertain_mutation" ||
    value.kind === "connection-interrupted"
  )
}

function QueueRow({
  labels,
  steer,
  onUnconfirmed,
}: {
  labels: MessageQueueLabels
  steer: NonNullable<ComposerFeatureViewModel["steer"]> | undefined
  onUnconfirmed(delivery: UnconfirmedDelivery): void
}) {
  const aui = useAui()
  const originThreadId = useAuiState((state) => state.threads.mainThreadId)
  const requestId = useAuiState((state) => state.queueItem.id)
  const parts = useAuiState((state) => state.queueItem.parts)
  const text = queueItemText(parts)
  const running = useAuiState((state) => state.thread.isRunning)
  const acknowledged = useAuiState((state) =>
    state.thread.messages.some((message) =>
      message.content.some(
        (part) =>
          part.type === "data" &&
          part.name === STEER_ACCEPTED_DATA_NAME &&
          part.data !== null &&
          typeof part.data === "object" &&
          (part.data as { requestId?: unknown }).requestId === requestId
      )
    )
  )
  const acknowledgedRef = useRef(false)
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle")

  useEffect(() => {
    if (!acknowledged) return
    if (aui.threads.getState().mainThreadId !== originThreadId) return
    acknowledgedRef.current = true
    aui.queueItem.remove()
  }, [acknowledged, aui, originThreadId])

  const submitSteering = useCallback(async () => {
    if (!steer || status === "pending") return
    setStatus("pending")
    try {
      await steer({ requestId, text })
      if (aui.threads.getState().mainThreadId !== originThreadId) return
      acknowledgedRef.current = true
      aui.queueItem.remove()
    } catch (error) {
      if (aui.threads.getState().mainThreadId !== originThreadId) return
      if (acknowledgedRef.current) return
      if (isUncertainDelivery(error)) {
        onUnconfirmed({ requestId, text })
        aui.queueItem.remove()
        return
      }
      setStatus("error")
    }
  }, [aui, onUnconfirmed, originThreadId, requestId, status, steer, text])

  const canSteer = running && steer !== undefined
  const pending = status === "pending"
  return (
    <li
      data-slot="aui_message-queue-item"
      className="flex min-h-10 min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-background px-2.5 py-1.5 text-sm shadow-xs motion-reduce:transition-none"
    >
      <CornerDownRightIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <QueueItemPrimitive.Text
        dir="auto"
        className="min-w-0 flex-1 truncate text-start text-foreground/85"
      />
      {status === "error" ? (
        <span className="shrink-0 text-xs text-destructive" role="status">
          {labels.failed}
        </span>
      ) : null}
      {canSteer ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={labels.steerLabel}
          disabled={pending}
          className="shrink-0 [@media(pointer:coarse)]:min-h-11"
          onClick={() => void submitSteering()}
        >
          {pending ? (
            <LoaderCircleIcon
              data-icon="inline-start"
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {labels.steer}
        </Button>
      ) : null}
      <QueueItemPrimitive.Remove
        render={
          <TooltipIconButton
            type="button"
            tooltip={labels.removeLabel}
            aria-label={labels.removeLabel}
            disabled={pending}
            className="size-8 shrink-0 [@media(pointer:coarse)]:size-11"
          />
        }
      >
        <Trash2Icon aria-hidden="true" />
      </QueueItemPrimitive.Remove>
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? labels.steering : status === "error" ? labels.failed : ""}
      </span>
    </li>
  )
}

export function MessageQueue({
  labels,
  steer,
  onUnconfirmed,
}: {
  labels: MessageQueueLabels
  steer: ComposerFeatureViewModel["steer"]
  onUnconfirmed(delivery: UnconfirmedDelivery): void
}) {
  return (
    <div
      data-slot="aui_message-queue"
      role="region"
      aria-label={labels.region}
      className="mb-2"
    >
      <ul className="flex min-w-0 flex-col gap-1">
        <ComposerPrimitive.Queue>
          {() => (
            <QueueRow
              labels={labels}
              steer={steer}
              onUnconfirmed={onUnconfirmed}
            />
          )}
        </ComposerPrimitive.Queue>
      </ul>
    </div>
  )
}
