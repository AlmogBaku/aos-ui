import { useInsertionEffect, useRef, useState } from "react"

type Handler = (...args: never[]) => unknown

/**
 * Gives every handler one identity for the caller's lifetime, so a state
 * change a consumer does not read does not hand it a new callback. Each
 * wrapper calls the latest committed render's handler, read when it runs and
 * never during render. The insertion effect updates it before any layout or
 * passive effect of that commit can call it. The set of keys is fixed by the
 * first render.
 */
export function useStableHandlers<T extends Record<string, Handler>>(
  handlers: T
): T {
  const latest = useRef(handlers)
  useInsertionEffect(() => {
    latest.current = handlers
  })
  const [stable] = useState(() => {
    const wrapped: Record<string, Handler> = {}
    for (const key of Object.keys(handlers)) {
      wrapped[key] = (...args) =>
        (latest.current[key] as (...args: unknown[]) => unknown)(...args)
    }
    return wrapped as T
  })
  return stable
}
