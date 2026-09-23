/**
 * A per-key list cache for MCP server and tool catalogs. A fetch is shared by
 * concurrent callers, reused for `ttlMs`, and a failed refetch keeps the last
 * good list so a flaky catalog endpoint never blanks resolved tool names.
 */
export type McpServerCache<T> = {
  /** Cached list; single-flight fetch; reused for ttlMs (default 5 min); a failed fetch keeps the last good list, or throws if none. */
  get(key: string): Promise<readonly T[]>
  /** For a lookup miss: refetch at most once per missRefetchMs (default 30 s) per key, else return the cached list. */
  refresh(key: string): Promise<readonly T[]>
}

type Entry<T> = {
  list?: readonly T[]
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
        entry.fetchedAt = now()
        entry.inflight = undefined
        return list
      },
      (error: unknown) => {
        // Retry no sooner than a miss would, so a down endpoint is not hammered.
        entry.fetchedAt = now()
        entry.inflight = undefined
        if (entry.list) return entry.list
        throw error
      }
    )
    entry.inflight = inflight
    return inflight
  }

  function withinAge(key: string, ageMs: number): readonly T[] | undefined {
    const entry = entries.get(key)
    if (!entry?.list || now() - entry.fetchedAt >= ageMs) return undefined
    return entry.list
  }

  return {
    get: (key) => {
      const fresh = withinAge(key, ttlMs)
      return fresh ? Promise.resolve(fresh) : load(key)
    },
    refresh: (key) => {
      const recent = withinAge(key, missRefetchMs)
      return recent ? Promise.resolve(recent) : load(key)
    },
  }
}

/** Finds an item in the cached list, refetching once on a miss. */
export async function resolveWithRefresh<T, R>(
  cache: McpServerCache<T>,
  key: string,
  find: (list: readonly T[]) => R | undefined
): Promise<R | undefined> {
  const hit = find(await cache.get(key))
  return hit ?? find(await cache.refresh(key))
}
