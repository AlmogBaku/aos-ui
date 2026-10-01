/** The speeds a media player's speed button steps through, in order. */
export const PLAYBACK_RATES: readonly number[] = [1, 1.25, 1.5, 2]

/**
 * The speed after `current`: the next listed one, wrapping from the fastest to
 * 1×. A speed the list does not hold, set some other way, moves to the first
 * listed speed above it.
 */
export function nextPlaybackRate(current: number) {
  return PLAYBACK_RATES.find((rate) => rate > current) ?? PLAYBACK_RATES[0]!
}
