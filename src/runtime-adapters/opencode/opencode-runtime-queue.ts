import {
  createMessageQueue,
  type AppendMessage,
  type ExternalThreadQueueAdapter,
  type MessageQueueController,
} from "@assistant-ui/react"
import type {
  OpenCodeThreadControllerLike,
  OpenCodeUserMessageOptions,
} from "@assistant-ui/react-opencode"

export type OpenCodeSessionQueue = {
  adapter: ExternalThreadQueueAdapter
  subscribe(listener: () => void): () => void
  syncBlocked(blocked: boolean): void
  cancel(): Promise<void>
  clear(): void
}

export function createOpenCodeSessionQueue(
  native: OpenCodeThreadControllerLike,
  getOptions: () => OpenCodeUserMessageOptions,
  onError?: (error: unknown) => void
): OpenCodeSessionQueue {
  let blocked = false
  let blockingEpoch = 0
  const run = (message: AppendMessage) => {
    const epochAtDispatch = blockingEpoch
    void native.sendMessage(message, getOptions()).then(
      () => {
        if (blockingEpoch === epochAtDispatch) queue.notifyIdle()
      },
      (error: unknown) => {
        if (blockingEpoch === epochAtDispatch) queue.notifyIdle()
        onError?.(error)
      }
    )
  }

  const queue: MessageQueueController = createMessageQueue({ run })

  return {
    adapter: queue.adapter,
    subscribe: queue.subscribe,
    syncBlocked(nextBlocked) {
      if (nextBlocked === blocked) return
      blocked = nextBlocked
      if (blocked) {
        blockingEpoch += 1
        queue.notifyBusy()
      } else {
        queue.notifyIdle()
      }
    },
    async cancel() {
      queue.notifyCancelled()
      await native.cancel()
    },
    clear: queue.clear,
  }
}
