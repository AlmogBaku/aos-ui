import { expect, it } from "vitest"

import { relativeTime } from "./relative-time"

// Local times, so the calendar day boundary holds in any time zone.
const now = new Date(2026, 8, 5, 12, 0)
const ago = (...parts: [number, number, number, number, number, number?]) =>
  new Date(...parts).toISOString()

it.each([
  ["a moment ago", ago(2026, 8, 5, 11, 59, 30), "short", "now"],
  ["a clock running ahead", ago(2026, 8, 5, 12, 5), "short", "now"],
  ["under an hour", ago(2026, 8, 5, 11, 1), "short", "59 min. ago"],
  ["an accessible name", ago(2026, 8, 5, 11, 58), "long", "2 minutes ago"],
  ["a full hour", ago(2026, 8, 5, 11, 0), "short", "1 hr. ago"],
  [
    "under a day, even across midnight",
    ago(2026, 8, 4, 13, 0),
    "short",
    "23 hr. ago",
  ],
  [
    "yesterday beyond a day",
    ago(2026, 8, 4, 8, 5),
    "short",
    "Yesterday, 8:05 AM",
  ],
  ["earlier this year", ago(2026, 8, 3, 23, 0), "short", "Sep 3"],
  ["an earlier year", ago(2025, 11, 30, 9, 0), "short", "Dec 30, 2025"],
] as const)("dates %s", (_case, at, style, expected) => {
  // ICU separates a time from its period with a narrow no-break space.
  expect(relativeTime(at, now, "en", style).replace(/\u202f/g, " ")).toBe(
    expected
  )
})
