import { createMessageQueue } from "@assistant-ui/core"
import type { AppendMessage, MessageQueueController } from "@assistant-ui/core"

import { AOS_JSONRPC_ERRORS } from "@aos/protocol/acp"

import type { QueueControls } from "@/runtime-adapters/queue-controls"

import type { ProjectorExecution } from "./session-projector"

/** The part of the ACP controller the queue drives and follows. */
export type QueueSession = {
  /** `holdBusy` hands a busy refusal back unshown, for a caller that retries. */
  readonly send: (
    message: AppendMessage,
    options: { holdBusy: boolean }
  ) => Promise<unknown>
  readonly getState: () => { readonly execution: ProjectorExecution }
  readonly subscribe: (listener: () => void) => () => void
}

/** A refusal because the proxy still holds the Session for an earlier turn. */
export const isBusyRefusal = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === AOS_JSONRPC_ERRORS.turnInProgress

const isBusy = ({ status }: ProjectorExecution) =>
  status === "running" || status === "waiting-for-input"

/**
 * The send the queue dispatched and waits on: the turn the Session last
 * reported as it went out, whether a turn has run since, and whether the
 * provider has accepted it yet.
 */
type Dispatch = {
  readonly before: string | undefined
  ran: boolean
  accepted: boolean
}

/**
 * How long a queued send keeps asking a Session the proxy still holds. The
 * browser can read a turn over before the proxy does, and the proxy never
 * queues, so the send waits here instead of being lost to the refusal.
 */
const BUSY_RETRY_MS = 60_000
const busyRetryDelay = (tries: number) => Math.min(250 * 2 ** tries, 2_000)

/** A message with its text parts replaced by one holding `text`. */
const withText = (message: AppendMessage, text: string): AppendMessage =>
  ({
    ...message,
    content: [
      { type: "text", text },
      ...message.content.filter((part) => part.type !== "text"),
    ],
  }) as AppendMessage

/** The waiting messages' texts in queue order, one paragraph each. */
const joinedText = (messages: readonly AppendMessage[]) =>
  messages
    .flatMap(({ content }) =>
      content.flatMap((part) =>
        part.type === "text" && part.text ? [part.text] : []
      )
    )
    .join("\n\n")

/**
 * The waiting messages as the one message the queue sends: `first`'s send
 * state, every text joined in queue order, and every other part and
 * attachment kept in that order.
 */
const combined = (
  first: AppendMessage,
  rest: readonly AppendMessage[]
): AppendMessage => {
  if (rest.length === 0) return first
  const all = [first, ...rest]
  return withText(
    {
      ...first,
      content: all.flatMap(({ content }) => [...content]),
      attachments: all.flatMap(({ attachments }) => attachments ?? []),
    } as AppendMessage,
    joinedText(all)
  )
}

/** Whether a queued message fits back into a composer: text and whole attachments. */
const composable = (message: AppendMessage) =>
  message.content.every((part) => part.type === "text") &&
  (message.attachments ?? []).every((attachment) => attachment.content)

/**
 * Holds the queue while a turn owns the Session. The proxy answers a prompt
 * as it accepts the turn, before the turn reports running, so a dispatched
 * send holds the queue until it is accepted and its turn has settled, in
 * whichever order the two arrive. A busy refusal sends again on backoff;
 * any other refusal, or one past the retry window, releases it at once.
 * The queue follows the controller directly: a render would see the turn
 * start only after the next send had already gone out.
 *
 * Every send carries all that waits, combined into one message. Its controls
 * hand the whole queue back to the composer.
 */
export function createQueue(session: QueueSession) {
  const execution = () => session.getState().execution
  let busy = false
  let dispatch: Dispatch | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  // A turn that failed before it ran, or ran while a replay held the telling,
  // settles under a turn the Session had not reported before.
  const settle = () => {
    if (!dispatch?.accepted || busy) return
    if (!dispatch.ran && execution().turnId === dispatch.before) return
    dispatch = undefined
    queue.notifyIdle()
  }
  const queue: MessageQueueController = createMessageQueue({
    run: (head) => {
      // Whatever still waits behind the head goes out with it, as one turn.
      const message = combined(head, takeWaiting())
      const until = Date.now() + BUSY_RETRY_MS
      const attempt = (tries: number) => {
        const again = () => {
          retry = setTimeout(() => attempt(tries + 1), busyRetryDelay(tries))
        }
        // A turn running meanwhile owns the Session: wait it out first.
        if (busy) return again()
        const sent: Dispatch = {
          before: execution().turnId,
          ran: false,
          accepted: false,
        }
        dispatch = sent
        const holdBusy = Date.now() < until
        session.send(message, { holdBusy }).then(
          () => {
            sent.accepted = true
            settle()
          },
          (error: unknown) => {
            if (holdBusy && isBusyRefusal(error)) return again()
            dispatch = undefined
            if (!busy) queue.notifyIdle()
          }
        )
      }
      attempt(0)
    },
  })

  // Each waiting message as it was queued, so the composer can take it back.
  // The adapter is wrapped in place: the runtime recomputes a message's
  // parent through this very object as it leaves the queue.
  const queued = new Map<string, AppendMessage>()
  const { adapter } = queue
  const remember =
    (push: (message: AppendMessage) => void) => (message: AppendMessage) => {
      push(message)
      const added = adapter.items.find((item) => !queued.has(item.id))
      if (added) queued.set(added.id, message)
    }
  adapter.enqueue = remember(adapter.enqueue)
  // With no `cancel`, the steer lane would only jump the line. An append the
  // composer did not mark (an MCP App's) waits in the one lane instead, so
  // `queueItem.move`, which cannot anchor across lanes, reorders every row.
  adapter.steer = adapter.enqueue
  queue.subscribe(() => {
    const waiting = new Set(adapter.items.map((item) => item.id))
    for (const id of queued.keys()) if (!waiting.has(id)) queued.delete(id)
  })
  /** Empties the queue, handing back every waiting message in order. */
  const takeWaiting = () => {
    const messages = adapter.items.flatMap(({ id }) => {
      const message = queued.get(id)
      return message ? [message] : []
    })
    for (const { id } of adapter.items) adapter.remove(id)
    return messages
  }
  const cancelled = queue.notifyCancelled
  // Stop is offered only while a turn is live. Only a running turn's Stop
  // reaches the queue: before the dispatched turn reports running, the queue
  // would count its start against the cancel and never see its idle.
  const notifyCancelled = () => {
    if (busy) cancelled()
  }
  queue.notifyCancelled = notifyCancelled
  adapter.__internal_notifyCancelled = notifyCancelled

  const observe = () => {
    const wasBusy = busy
    busy = isBusy(execution())
    if (busy) {
      if (!wasBusy) queue.notifyBusy()
      if (dispatch) dispatch.ran = true
    } else if (dispatch) settle()
    else if (wasBusy) queue.notifyIdle()
  }
  /** Follows the Session's execution until the returned call stops it. */
  const watch = () => {
    observe()
    const unsubscribe = session.subscribe(observe)
    return () => {
      unsubscribe()
      clearTimeout(retry)
    }
  }

  const controls: QueueControls = {
    takeAll: () => {
      const waiting = adapter.items.map(({ id }) => queued.get(id))
      if (waiting.length === 0) return undefined
      if (!waiting.every((message) => message && composable(message)))
        return undefined
      const messages = takeWaiting()
      return {
        text: joinedText(messages),
        attachments: messages.flatMap((message) => message.attachments ?? []),
      }
    },
  }
  return { queue, watch, controls }
}
