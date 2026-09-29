import { StopReason, TurnEventKind, type TurnEvent } from "./events"
import { ServerTurnEndedError } from "./runtime"

/**
 * A prompt's storage receipt, the `stored` of its turn's handle: `resolve`
 * names the message id the provider stored the prompt under, and `end`, called
 * with the event that ended the turn, rejects a receipt still unproven.
 */
export function storageReceipt() {
  let resolve!: (messageId: string) => void
  let reject!: (cause: ServerTurnEndedError) => void
  const promise = new Promise<string>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  // A turn that ended unstored is no failure of whoever never awaited it.
  promise.catch(() => undefined)
  return {
    promise,
    resolve,
    end(ending?: TurnEvent) {
      reject(
        ending?.kind === TurnEventKind.TurnFailed
          ? new ServerTurnEndedError("failed", ending.code)
          : new ServerTurnEndedError(
              ending?.kind === TurnEventKind.TurnEnded &&
                ending.stopReason === StopReason.Cancelled
                ? "stopped"
                : "ended"
            )
      )
    },
  }
}
