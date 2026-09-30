/**
 * Queues calls to `send` so at most `limit` start in any rolling window, in
 * call order. The page refuses a frame that sends too fast, so a view paces its
 * own reads below the page's limit instead of retrying refused ones.
 */
export function rateLimited<A, R>(
  send: (argument: A) => Promise<R>,
  limit = 8,
  windowMs = 1_000
): (argument: A) => Promise<R> {
  const starts: number[] = []
  let queue = Promise.resolve()
  return (argument) => {
    const turn = queue.then(async () => {
      if (starts.length === limit) {
        const wait = starts.shift()! + windowMs - performance.now()
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      }
      starts.push(performance.now())
    })
    queue = turn
    return turn.then(() => send(argument))
  }
}
