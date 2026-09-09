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
  /** Pause dispatch without discarding input; the release is idempotent. */
  hold(): () => void
  cancel(): Promise<void>
  clear(): void
}

export function createOpenCodeSessionQueue(
  native: OpenCodeThreadControllerLike,
  getOptions: () => OpenCodeUserMessageOptions,
  onError?: (error: unknown) => void
): OpenCodeSessionQueue {
  let nativeBlocked = false
  let holds = 0
  let deferredIdle = false
  let parked = false
  let syntheticBusy = false
  let blockingEpoch = 0
  const notifyIdle = () => {
    if (holds > 0) deferredIdle = true
    else queue.notifyIdle()
  }
  const run = (message: AppendMessage) => {
    const epochAtDispatch = blockingEpoch
    void native.sendMessage(message, getOptions()).then(
      () => {
        if (blockingEpoch === epochAtDispatch) notifyIdle()
      },
      (error: unknown) => {
        if (blockingEpoch === epochAtDispatch) notifyIdle()
        onError?.(error)
      }
    )
  }

  const queue: MessageQueueController = createMessageQueue({ run })
  const notifyCancelled = () => {
    parked = true
    queue.notifyCancelled()
  }
  const adapter: ExternalThreadQueueAdapter = {
    ...queue.adapter,
    get items() {
      return queue.adapter.items
    },
    get steerItems() {
      return queue.adapter.steerItems
    },
    enqueue(message) {
      parked = false
      queue.adapter.enqueue(message)
    },
    steer(message) {
      parked = false
      queue.adapter.steer(message)
    },
    __internal_notifyCancelled: notifyCancelled,
  }

  return {
    adapter,
    subscribe: queue.subscribe,
    syncBlocked(nextBlocked) {
      if (nextBlocked === nativeBlocked) return
      nativeBlocked = nextBlocked
      if (nativeBlocked) {
        parked = false
        deferredIdle = false
        blockingEpoch += 1
        queue.notifyBusy()
      } else {
        notifyIdle()
      }
    },
    hold() {
      if (holds === 0 && !nativeBlocked) {
        // Block new input too, retaining Stop's pause for restoration on release.
        syntheticBusy = true
        blockingEpoch += 1
        queue.notifyBusy()
      }
      holds += 1
      let released = false
      return () => {
        if (released) return
        released = true
        holds -= 1
        if (holds === 0 && (deferredIdle || syntheticBusy)) {
          deferredIdle = false
          syntheticBusy = false
          if (!nativeBlocked) {
            if (parked) queue.notifyCancelled()
            queue.notifyIdle()
          }
        }
      }
    },
    async cancel() {
      notifyCancelled()
      await native.cancel()
    },
    clear: queue.clear,
  }
}
