const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/**
 * When something happened, as an inbox row says it: "now", minutes, hours,
 * "Yesterday, 18:40", then a short date. The visible line is `short`; an
 * accessible name reads the `long` form.
 */
export function relativeTime(
  at: string,
  now: Date,
  locale: string,
  style: "long" | "short" = "short"
) {
  const time = new Date(at)
  const elapsed = Math.max(0, now.getTime() - time.getTime())
  const relative = new Intl.RelativeTimeFormat(locale, { style })
  if (elapsed < MINUTE_MS)
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      0,
      "second"
    )
  if (elapsed < HOUR_MS)
    return relative.format(-Math.floor(elapsed / MINUTE_MS), "minute")
  if (elapsed < 24 * HOUR_MS)
    return relative.format(-Math.floor(elapsed / HOUR_MS), "hour")
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (time.toDateString() === yesterday.toDateString()) {
    const day = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      -1,
      "day"
    )
    const clock = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(time)
    return `${day.charAt(0).toLocaleUpperCase(locale)}${day.slice(1)}, ${clock}`
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(time.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(time)
}
