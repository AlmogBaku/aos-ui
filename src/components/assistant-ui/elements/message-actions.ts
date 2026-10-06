import {
  useActionBarCopy,
  useActionBarEdit,
  useActionBarReload,
} from "@assistant-ui/core/react"
import { useAui, useAuiState } from "@assistant-ui/react"
import { useCallback, useMemo } from "react"

import { usePendingInteractionGate } from "@/components/runtime-interactions/pending-interaction-context"
import { copyMarkdownToClipboard } from "@/lib/clipboard"

import { useVoiceContext } from "../voice/voice-context"
import type { MessageRewind } from "./thread.aui"
import { answerText } from "./turn-fold"

/*
 * What a message action is, and whether this turn can carry it out right now.
 * The hover action bar and the context menu both read it from here, so the two
 * surfaces cannot offer the same action in two different states.
 */

/**
 * Copies through the clipboard helper that survives a denied Clipboard API.
 * Assistant UI hands over every text part of the message joined; an assistant
 * turn copies only its answer, the prose its fold leaves visible.
 */
export function useMessageCopy(): { copy: () => void; disabled: boolean } {
  const aui = useAui()
  const options = useMemo(
    () => ({
      copyToClipboard: (text: string) => {
        const message = aui.message.getState()
        return copyMarkdownToClipboard(
          message.role === "assistant" ? answerText(message.content) : text
        )
      },
    }),
    [aui]
  )
  const { copy, disabled } = useActionBarCopy(options)
  return { copy, disabled }
}

/**
 * Retrying an assistant turn rewinds to the user turn that produced it, so the
 * provider replays from there instead of appending. Reading aloud stops: the
 * answer being read is about to be replaced.
 */
export function useMessageRetry(messageRewind: MessageRewind | undefined): {
  retry: () => void
  disabled: boolean
} {
  const aui = useAui()
  const voice = useVoiceContext()
  const { reload, disabled } = useActionBarReload()
  const retrySourceId = useAuiState((state) => state.message.parentId)
  const hasPendingInteraction = usePendingInteractionGate()

  const retry = useCallback(() => {
    if (messageRewind === false) return
    if (messageRewind) {
      if (retrySourceId)
        void aui.message.reload({
          runConfig: messageRewind.runConfig(retrySourceId),
        })
    } else {
      reload()
    }
    voice?.media.stopSpeech()
    voice?.media.disarm()
  }, [aui, messageRewind, reload, retrySourceId, voice])

  return { retry, disabled: disabled || hasPendingInteraction }
}

export function useMessageEdit(): { edit: () => void; disabled: boolean } {
  const { edit, disabled } = useActionBarEdit()
  const hasPendingInteraction = usePendingInteractionGate()
  return { edit, disabled: disabled || hasPendingInteraction }
}
