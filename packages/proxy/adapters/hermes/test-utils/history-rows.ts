/**
 * Builders for authoritative Hermes history rows as consumed by history.ts.
 *
 * Each builder produces a plain object whose shape mirrors the JSON rows that
 * Hermes returns from its HTTP history endpoint.  These are the shapes that
 * `projectHermesHistory` in history.ts processes.
 *
 * Pair an `assistantToolCall` row with the matching `toolRow` when testing
 * history projection, and pair with `nativeTurn` tool frames from
 * native-events.ts when asserting live/history parity.
 */

export type AssistantRow = {
  id: string
  row_id?: number
  display_kind?: string
  role: "assistant"
  timestamp?: number
  content?: string
  tool_calls?: ToolCallEntry[]
}

export type ToolRow = {
  row_id?: number
  display_kind?: string
  role: "tool"
  tool_call_id: string
  tool_name?: string
  content: string
  is_error?: boolean
}

export type UserRow = {
  id: string
  row_id?: number
  display_kind?: string
  role: "user"
  timestamp?: number
  content: string | ContentPart[]
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

type ToolCallEntry = {
  id: string
  function: {
    name: string
    arguments: string
  }
}

// ---------------------------------------------------------------------------
// Assistant-message builders
// ---------------------------------------------------------------------------

/** An assistant row that carries one or more tool_call entries. */
export function assistantToolCall(
  id: string,
  toolCalls: Array<{ toolCallId: string; name: string; args: unknown }>,
  options: {
    timestamp?: number
    content?: string
    rowId?: number
    displayKind?: string
  } = {}
): AssistantRow {
  return {
    id,
    role: "assistant",
    ...(options.rowId !== undefined ? { row_id: options.rowId } : {}),
    ...(options.displayKind !== undefined
      ? { display_kind: options.displayKind }
      : {}),
    ...(options.timestamp !== undefined
      ? { timestamp: options.timestamp }
      : {}),
    ...(options.content !== undefined ? { content: options.content } : {}),
    tool_calls: toolCalls.map(({ toolCallId, name, args }) => ({
      id: toolCallId,
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    })),
  }
}

/** An assistant text-only row (no tool calls). */
export function assistantText(
  id: string,
  content: string,
  options: { timestamp?: number; rowId?: number; displayKind?: string } = {}
): AssistantRow {
  return {
    id,
    role: "assistant",
    content,
    ...(options.rowId !== undefined ? { row_id: options.rowId } : {}),
    ...(options.displayKind !== undefined
      ? { display_kind: options.displayKind }
      : {}),
    ...(options.timestamp !== undefined
      ? { timestamp: options.timestamp }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Tool-result row builders
// ---------------------------------------------------------------------------

/**
 * A `role: "tool"` row matching `assistantToolCall` output.
 *
 * @param toolCallId  Must match the `toolCallId` passed to `assistantToolCall`.
 * @param name        Tool name (stored as `tool_name` in the history row).
 * @param content     The raw result value.  Objects are JSON-serialised.
 * @param isError     When `true`, sets `is_error: true`.
 * @param options     Optional `rowId`/`displayKind` for history.ts dedup/skip.
 */
export function toolRow(
  toolCallId: string,
  name: string,
  content: unknown,
  isError = false,
  options: { rowId?: number; displayKind?: string } = {}
): ToolRow {
  const contentString =
    typeof content === "string" ? content : JSON.stringify(content)
  return {
    role: "tool",
    tool_call_id: toolCallId,
    tool_name: name,
    content: contentString,
    ...(isError ? { is_error: true } : {}),
    ...(options.rowId !== undefined ? { row_id: options.rowId } : {}),
    ...(options.displayKind !== undefined
      ? { display_kind: options.displayKind }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// User-row builder
// ---------------------------------------------------------------------------

/** A simple user text row. */
export function userRow(
  id: string,
  content: string,
  options: { timestamp?: number; rowId?: number; displayKind?: string } = {}
): UserRow {
  return {
    id,
    role: "user",
    content,
    ...(options.rowId !== undefined ? { row_id: options.rowId } : {}),
    ...(options.displayKind !== undefined
      ? { display_kind: options.displayKind }
      : {}),
    ...(options.timestamp !== undefined
      ? { timestamp: options.timestamp }
      : {}),
  }
}
