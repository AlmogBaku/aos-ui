import {
  createMessageQueue,
  type AppendMessage,
  type MessageQueueController,
} from "@assistant-ui/react"

import type { HermesNativeClient, HermesSession } from "./hermes-native-client"

export type HermesMessageQueue = {
  controller: MessageQueueController
  sync(session: HermesSession | undefined): void
}

/** Keeps queued prompts parked until Hermes explicitly reports a safe idle state. */
export function createHermesMessageQueue(
  client: Pick<HermesNativeClient, "submit">,
  threadId: string,
  onError?: (error: Error) => void
): HermesMessageQueue {
  const state: { controller?: MessageQueueController } = {}
  // The provider state is unknown until the selected Session attaches. Start
  // busy so the queue cannot treat absence of a running flag as safe idle.
  let nativeRunInFlight = true
  const controller = createMessageQueue({
    run(message: AppendMessage) {
      void client.submit(threadId, message).catch((reason) => {
        state.controller?.notifyCancelled()
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      })
    },
  })
  state.controller = controller
  controller.notifyBusy()
  return {
    controller,
    sync(session) {
      if (session?.running) {
        if (!nativeRunInFlight) controller.notifyBusy()
        nativeRunInFlight = true
        return
      }
      const safelyIdle = session?.status === "idle" && !session.approval
      if (safelyIdle && nativeRunInFlight) {
        controller.notifyIdle()
        nativeRunInFlight = false
      }
    },
  }
}
