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
  // The key the sentinel was last seen in view at, or null while it is not.
  const [inViewAt, setInViewAt] = useState<{ key: unknown } | null>(null)
  // The key the last automatic read started from.
  const readFrom = useRef<{ key: unknown } | null>(null)

  // Observed afresh for every key: a read that lands moves the rows, and the
  // sentinel's place before it says nothing about its place after it.
  useEffect(() => {
    if (!sentinel || typeof IntersectionObserver !== "function") return
    const observer = new IntersectionObserver(
      // One delivery can batch several crossings, oldest first: a list that
      // mounts at its start and then scrolls to its end reports both, and
      // only the last is where the sentinel is now.
      (entries) =>
        setInViewAt(
          entries.at(-1)?.isIntersecting === true ? { key: loadKey } : null
        ),
      { root: root?.current ?? null, ...(rootMargin ? { rootMargin } : {}) }
    )
    observer.observe(sentinel)
    return () => {
      observer.disconnect()
      setInViewAt(null)
    }
  }, [loadKey, root, rootMargin, sentinel])

  useEffect(() => {
    if (!inViewAt) {
      readFrom.current = null
      return
    }
    if (
      inViewAt.key !== loadKey ||
      disabled ||
      readFrom.current?.key === loadKey
    )
      return
    readFrom.current = { key: loadKey }
    load()
  }, [disabled, inViewAt, load, loadKey])

  return setSentinel
}
