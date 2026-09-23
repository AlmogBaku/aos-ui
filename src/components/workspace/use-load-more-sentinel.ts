import { useEffect, useRef, useState, type RefObject } from "react"

export type LoadMoreSentinelOptions = {
  load: () => void
  /** No automatic read while true; an explicit control still reads. */
  disabled: boolean
  /**
   * What the last read changed, such as how many rows are listed. While the
   * sentinel stays in view it reads again only once this changes, so a read
   * that brought nothing waits for the explicit control instead of looping.
   */
  loadKey: unknown
  /** The scrolling element the sentinel is watched in; the page by default. */
  root?: RefObject<Element | null>
  /** How far beyond the root's edges the sentinel already counts as in view. */
  rootMargin?: string
}

/**
 * Reads the next page when a sentinel scrolls into view. Returns the ref for
 * the sentinel element, which may mount and unmount as pages run out.
 */
export function useLoadMoreSentinel({
  load,
  disabled,
  loadKey,
  root,
  rootMargin,
}: LoadMoreSentinelOptions) {
  const [sentinel, setSentinel] = useState<Element | null>(null)
  const [inView, setInView] = useState(false)
  // The key the last automatic read started from.
  const readFrom = useRef<{ key: unknown } | null>(null)

  useEffect(() => {
    if (!sentinel || typeof IntersectionObserver !== "function") return
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting === true),
      { root: root?.current ?? null, ...(rootMargin ? { rootMargin } : {}) }
    )
    observer.observe(sentinel)
    return () => {
      observer.disconnect()
      setInView(false)
    }
  }, [root, rootMargin, sentinel])

  useEffect(() => {
    if (!inView) {
      readFrom.current = null
      return
    }
    if (disabled || (readFrom.current && readFrom.current.key === loadKey))
      return
    readFrom.current = { key: loadKey }
    load()
  }, [disabled, inView, load, loadKey])

  return setSentinel
}
