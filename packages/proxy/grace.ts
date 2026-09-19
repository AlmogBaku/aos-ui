/** Waits `ms` without holding the process open on its own. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer !== "number") timer.unref()
  })
}

/**
 * Runs `work` and waits for it at most `graceMs`.
 *
 * Resolves `true` when the work settled inside the grace and `false` when the
 * grace expired first; expired work keeps running unobserved. A failure counts
 * as settled, because a bounded shutdown cares about the wait and never about
 * the outcome. The wait timer is unref'd, so a pending grace never keeps the
 * process alive on its own.
 */
export function withinGrace(
  work: () => Promise<unknown> | void,
  graceMs: number
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, graceMs))
    if (typeof timer !== "number") timer.unref()
    const settled = () => {
      clearTimeout(timer)
      resolve(true)
    }
    void Promise.resolve().then(work).then(settled, settled)
  })
}
