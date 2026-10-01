/**
 * A per-key list cache for MCP server and tool catalogs. A fetch is shared by
 * concurrent callers, reused for `ttlMs`, and a failed refetch keeps the last
 * good list so a flaky catalog endpoint never blanks resolved tool names. A
 * fetch that failed with no list to keep fails again until a miss may refetch,
 * so a server that does not answer costs one wait, not one per read.
 */
export type McpServerCache<T> = {
  /** Cached list; single-flight fetch; reused for ttlMs (default 5 min); a failed fetch keeps the last good list, or throws if none, again until missRefetchMs passed. */
  get(key: string): Promise<readonly T[]>
  /** For a lookup miss: refetch at most once per missRefetchMs (default 30 s) per key, else return the cached list. */
  refresh(key: string): Promise<readonly T[]>
}

type Entry<T> = {
  list?: readonly T[]
  /** The last fetch's failure, kept while no list stands in for it. */
  failed?: { error: unknown }
  fetchedAt: number
  inflight?: Promise<readonly T[]>
}

export function createMcpServerCache<T>(
  fetch: (key: string) => Promise<readonly T[]>,
  options: { ttlMs?: number; missRefetchMs?: number; now?: () => number } = {}
): McpServerCache<T> {
  const ttlMs = options.ttlMs ?? 5 * 60_000
  const missRefetchMs = options.missRefetchMs ?? 30_000
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry<T>>()

  function load(key: string): Promise<readonly T[]> {
    const entry = entries.get(key) ?? { fetchedAt: -Infinity }
    entries.set(key, entry)
    if (entry.inflight) return entry.inflight
    const inflight = fetch(key).then(
      (list) => {
        entry.list = list
        entry.failed = undefined
        entry.fetchedAt = now()
        entry.inflight = undefined
        return list
      },
      (error: unknown) => {
        // Retry no sooner than a miss would, so a down endpoint is not hammered.
        entry.fetchedAt = now()
        entry.inflight = undefined
        if (entry.list) return entry.list
        entry.failed = { error }
        throw error
      }
    )
    entry.inflight = inflight
    return inflight
  }

  /** The list fetched within `ageMs`, or the failure of one that found none. */
  function withinAge(
    key: string,
    ageMs: number
  ): Promise<readonly T[]> | undefined {
    const entry = entries.get(key)
    if (!entry) return undefined
    const age = now() - entry.fetchedAt
    if (entry.list) return age < ageMs ? Promise.resolve(entry.list) : undefined
    return entry.failed && age < missRefetchMs
      ? Promise.reject(entry.failed.error)
      : undefined
  }

  return {
    get: (key) => withinAge(key, ttlMs) ?? load(key),
    refresh: (key) => withinAge(key, missRefetchMs) ?? load(key),
  }
}
