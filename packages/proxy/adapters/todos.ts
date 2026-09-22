/**
 * The one Session-Todo projection every native adapter shares.
 *
 * Providers agree on the shape of a Todo list and disagree only on the words
 * they use for a Todo's state, so the projection is shared and the vocabulary
 * is a per-adapter alias table. This module is a leaf: it imports nothing from
 * an adapter, and an adapter never reimplements the bounds it enforces.
 */

export type Todo = {
  id: string
  label: string
  status: "pending" | "active" | "completed" | "failed"
}

/**
 * Session Todos are a plan a person reads, and the frame carrying them is bound
 * by bytes alone. A list longer than this is machine noise or a corrupt payload,
 * so the projection truncates it instead of publishing an unbounded PLAN.
 */
const MAX_PROJECTED_TODOS = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A provider may deliver the list as a value or as serialized tool output. */
function parseJsonOrValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function stringValue(value: unknown, max: number) {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined
}

/**
 * Projects a native Todo payload onto the normalized list, or reports
 * `undefined` when the payload does not carry a Todo list at all. `undefined`
 * and an empty array are different answers: the first leaves the browser's
 * plan standing, the second publishes an empty one.
 *
 * `statusAliases` renames a native state before the normalized vocabulary is
 * checked; an unmapped or unknown state is `pending` rather than invented.
 */
export function projectTodos(
  value: unknown,
  statusAliases: Readonly<Record<string, string>> = {}
): Todo[] | undefined {
  const payload = parseJsonOrValue(value)
  if (!isRecord(payload) || !Array.isArray(payload.todos)) return undefined
  const seen = new Set<string>()
  return payload.todos.slice(0, MAX_PROJECTED_TODOS).flatMap((raw, index) => {
    if (!isRecord(raw)) return []
    const id = stringValue(raw.id, 256) ?? String(index)
    const label = stringValue(raw.label ?? raw.content, 4_096)
    if (!label || seen.has(id)) return []
    seen.add(id)
    const nativeStatus = stringValue(raw.status, 64)
    const rawStatus =
      nativeStatus !== undefined && Object.hasOwn(statusAliases, nativeStatus)
        ? statusAliases[nativeStatus]
        : nativeStatus
    const status =
      rawStatus === "active" ||
      rawStatus === "completed" ||
      rawStatus === "failed" ||
      rawStatus === "pending"
        ? rawStatus
        : "pending"
    return [{ id, label, status }]
  })
}
