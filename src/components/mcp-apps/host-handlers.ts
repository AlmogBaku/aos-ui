/**
 * The host's answers to what an App view asks of it, kept pure so each policy
 * is testable without a sandboxed frame.
 */

type ContentBlock = { readonly type: string; readonly text?: unknown }

/** A view may open a link only in a new, unrelated `https` browsing context. */
export function openAppLink(
  url: string,
  open: (url: string, target: string, features: string) => unknown = (
    ...args
  ) => window.open(...args)
): { isError?: true } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { isError: true }
  }
  if (parsed.protocol !== "https:") return { isError: true }
  open(parsed.href, "_blank", "noopener,noreferrer")
  return {}
}

/**
 * The text a `ui/message` would send as the operator's next turn, or
 * `undefined` when it carries anything but non-empty text.
 */
export function appMessageText(message: {
  readonly role: string
  readonly content: readonly ContentBlock[]
}): string | undefined {
  if (message.role !== "user" || message.content.length === 0) return undefined
  const texts: string[] = []
  for (const block of message.content) {
    if (block.type !== "text" || typeof block.text !== "string")
      return undefined
    texts.push(block.text)
  }
  const text = texts.join("\n\n").trim()
  return text || undefined
}

/** Admits at most `limit` calls in any `windowMs`; the rest are refused. */
export function createRateLimiter(
  limit = 10,
  windowMs = 1_000,
  now: () => number = Date.now
) {
  const admitted: number[] = []
  return () => {
    const at = now()
    while (at - (admitted[0] ?? at) >= windowMs) admitted.shift()
    if (admitted.length >= limit) return false
    admitted.push(at)
    return true
  }
}

/** The display modes this host can give a view: in the message, or covering the viewport. */
export const AVAILABLE_DISPLAY_MODES = ["inline", "fullscreen"] as const
export type AppDisplayMode = (typeof AVAILABLE_DISPLAY_MODES)[number]

/**
 * The mode a `ui/request-display-mode` leaves the view in: the one it asked
 * for when this host offers it and the view declared it among its
 * `availableDisplayModes` (when it declared any), otherwise the one it already
 * had.
 */
export function grantDisplayMode(
  requested: string,
  current: AppDisplayMode,
  declared?: readonly string[]
): AppDisplayMode {
  if (declared && !declared.includes(requested)) return current
  return AVAILABLE_DISPLAY_MODES.find((mode) => mode === requested) ?? current
}
