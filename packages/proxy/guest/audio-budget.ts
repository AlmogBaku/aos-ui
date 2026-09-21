type Usage = { inFlight: number; ops: number[] }

/**
 * A per-conversation ceiling on operator-paid speech. One invitation link may
 * hold only a few operations at a time and only so many within a window, so a
 * holder cannot spend a provider budget without bound in either direction.
 */
export function createGuestAudioBudget(options: {
  now: () => number
  windowMs: number
  maxInFlight: number
  maxOps: number
}) {
  const usage = new Map<string, Usage>()

  /** This conversation's usage with aged-out operations dropped; a drained
   * conversation leaves the map the next time it speaks, so the map tracks
   * conversations that keep speaking rather than every one that ever did. */
  const live = (ref: string, current: number): Usage => {
    const entry = usage.get(ref)
    if (!entry) return { inFlight: 0, ops: [] }
    entry.ops = entry.ops.filter((at) => at > current - options.windowMs)
    if (entry.inFlight === 0 && entry.ops.length === 0) usage.delete(ref)
    return entry
  }

  return {
    /** Counts one operation now (never refunded). Returns the release for the
     * in-flight slot, or undefined when the conversation is over budget. */
    acquire(ref: string) {
      const current = options.now()
      const entry = live(ref, current)
      if (
        entry.inFlight >= options.maxInFlight ||
        entry.ops.length >= options.maxOps
      )
        return undefined
      entry.ops.push(current)
      entry.inFlight += 1
      usage.set(ref, entry)
      let released = false
      return () => {
        if (released) return
        released = true
        entry.inFlight -= 1
      }
    },
  }
}
