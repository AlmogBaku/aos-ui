import {
  useActionBarCopy,
  useActionBarEdit,
  useActionBarReload,
} from "@assistant-ui/core/react"
import { useAui } from "@assistant-ui/react"
import { useCallback, useMemo } from "react"

import { usePendingInteractionGate } from "@/components/runtime-interactions/pending-interaction-context"
import { copyMarkdownToClipboard } from "@/lib/clipboard"

import { useVoiceContext } from "../voice/voice-context"
import type { VoiceMediaController } from "../voice/voice-media"
import type { MessageRewind } from "./thread.aui"
import { answerText } from "./turn-fold"

/*
 * What a message action is, and whether this turn can carry it out right now.
 * The hover action bar and the context menu both read it from here, so the two
 * surfaces cannot offer the same action in two different states.
 */

type CopiedMessage = {
  readonly role: string
  readonly content: Parameters<typeof answerText>[0]
}

/**
 * Copies through the clipboard helper that survives a denied Clipboard API.
 * An assistant turn copies only its answer, the prose its fold leaves
 * visible; any other message copies `text`, every text part joined.
 */
export function copyMessage(message: CopiedMessage, text = "") {
  return copyMarkdownToClipboard(
    message.role === "assistant" ? answerText(message.content) : text
  )
}

/** The message action bar's and the context menu's Copy. */
export function useMessageCopy(): { copy: () => void; disabled: boolean } {
  const aui = useAui()
  const options = useMemo(
    () => ({
      copyToClipboard: (text: string) =>
        copyMessage(aui.message.getState(), text),
    }),
    [aui]
  )
  const { copy, disabled } = useActionBarCopy(options)
  return { copy, disabled }
}

type RetriedMessage = {
  reload(config?: { runConfig?: { custom?: Record<string, unknown> } }): unknown
  getState(): { readonly parentId: string | null }
}

/**
 * Retrying an assistant turn rewinds to the user turn that produced it, so the
 * provider replays from there instead of appending. Reading aloud stops: the
 * answer being read is about to be replaced.
 */
export function retryMessage(
  message: RetriedMessage,
  messageRewind: MessageRewind | undefined,
  media: Pick<VoiceMediaController, "stopSpeech" | "disarm"> | undefined
) {
  if (messageRewind === false) return
  if (messageRewind) {
    const sourceId = message.getState().parentId
    if (sourceId)
      message.reload({ runConfig: messageRewind.runConfig(sourceId) })
  } else {
    message.reload()
  }
  media?.stopSpeech()
  media?.disarm()
}

/** The message action bar's and the context menu's Retry. */
export function useMessageRetry(messageRewind: MessageRewind | undefined): {
  retry: () => void
  disabled: boolean
} {
  const aui = useAui()
  const voice = useVoiceContext()
  const { disabled } = useActionBarReload()
  const hasPendingInteraction = usePendingInteractionGate()

  const retry = useCallback(
    () => retryMessage(aui.message, messageRewind, voice?.media),
    [aui, messageRewind, voice]
  )

  return { retry, disabled: disabled || hasPendingInteraction }
}

type EditableComposer = {
  getState(): { readonly isEditing: boolean }
  beginEdit(): void
  cancel(): void
}

/**
 * The composer holds one edit at a time, so beginning one ends any other. A
 * message already being edited stays as it is.
 */
export function beginOnlyEdit(
  messageIds: readonly string[],
  composerOf: (messageId: string) => EditableComposer,
  messageId: string
) {
  const target = composerOf(messageId)
  if (target.getState().isEditing) return
  for (const id of messageIds) {
    if (id === messageId) continue
    const composer = composerOf(id)
    if (composer.getState().isEditing) composer.cancel()
  }
  target.beginEdit()
}

export function useMessageEdit(): { edit: () => void; disabled: boolean } {
  const aui = useAui()
  const { disabled } = useActionBarEdit()
  const hasPendingInteraction = usePendingInteractionGate()
  const edit = useCallback(
    () =>
      beginOnlyEdit(
        aui.thread.getState().messages.map(({ id }) => id),
        (id) => aui.thread.message({ id }).composer(),
        aui.message.getState().id
      ),
    [aui]
  )
  return { edit, disabled: disabled || hasPendingInteraction }
}
