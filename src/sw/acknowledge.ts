/// <reference lib="webworker" />

/**
 * The proof a window took a notification click.
 *
 * `clients.matchAll({ includeUncontrolled: true })` answers which documents
 * exist, not which of them are running the app: a window restored by a browser
 * that has just started, a frozen or discarded document, and a tab still loading
 * the bundle are all returned, and a message posted to one of them reaches no
 * listener. The worker therefore hands the window a port and waits for an
 * answer; silence sends the click on to `openWindow`, which needs no page.
 */
export type Acknowledgement = {
  /** Transferred to the window so it can answer. */
  port: MessagePort
  /** Whether a window answered before the deadline. */
  answered: Promise<boolean>
}

/**
 * Bounded so a silent window cannot hold the click open: a running page answers
 * in milliseconds, and a second still leaves most of the five seconds of
 * activation a click grants, which `openWindow` needs afterwards.
 */
const ANSWER_TIMEOUT_MS = 1_000

export function acknowledge(timeoutMs = ANSWER_TIMEOUT_MS): Acknowledgement {
  const { port1, port2 } = new MessageChannel()
  let timer: ReturnType<typeof setTimeout> | undefined
  const answered = new Promise<boolean>((resolve) => {
    const settle = (answer: boolean) => {
      if (timer !== undefined) clearTimeout(timer)
      port1.onmessage = null
      port1.close()
      resolve(answer)
    }
    timer = setTimeout(() => settle(false), timeoutMs)
    port1.onmessage = () => settle(true)
  })
  return { port: port2, answered }
}
