/**
 * The model-facing rows Hermes persists as ordinary user rows, and what each
 * one is to the operator. The dashboard messages route returns stored rows as
 * they are (only a compaction carrier gains `display_content`), so every class
 * below is recognized here. Markers are quoted from the Hermes files cited
 * beside them, at the commit pinned in `UPSTREAM.md` unless noted.
 */

/**
 * What a stored row is to the operator:
 * - `prompt`: shown as its role projects it; a user prompt opens a turn.
 * - `correction`: shown, flagged as a correction of the running turn.
 * - `automation`: hidden, but opens a turn so its reply is its own message.
 * - `skip`: hidden, and opens no turn, so the reply stays with its request.
 */
export type HermesRowKind = "prompt" | "correction" | "automation" | "skip"

/** A row's class and, for a shown user row, the text it shows. */
export type HermesRowClass = { kind: HermesRowKind; text: string }

/** Openers of rows only the model reads. */
export const MODEL_ONLY_PREFIXES: readonly string[] = [
  // Gateway notices and recovery nudges: `tui_gateway/session_history.py`
  // `_is_display_hidden_marker`, `agent/conversation_loop.py` nudges.
  "[System:",
  // The in-flight request compaction restates: `agent/context_compressor.py`
  // `_INFLIGHT_TASK_REPLAY_HEADER`.
  "[STILL IN PROGRESS",
  // The todo snapshot compaction re-injects: `tools/todo_tool.py`
  // `TODO_INJECTION_HEADER`.
  "[Your active task list was preserved across context compression]",
  // Its reload notice: `agent/conversation_compression.py`
  // `_PRUNED_SKILL_RELOAD_NOTICE_HEADER`.
  "[Skills pruned during compression",
  // The handoff when no human turn survived: `agent/context_compressor.py`
  // `COMPRESSION_CONTINUATION_USER_CONTENT` and its legacy twin.
  "Continue from the compressed conversation context above",
]

/**
 * A background process's still-running heartbeat, persisted untyped before
 * Hermes tagged the wake `hidden`: `tools/process_registry_notifications.py`
 * `_format_process_notification` (newer than the pinned commit).
 */
const LEGACY_PROCESS_HEARTBEAT = /^\[Background process \S+ heartbeat #/u

/**
 * Headers Hermes appends after `\n\n` to a row with real content: compaction
 * folds the todo snapshot into the last real prompt
 * (`agent/conversation_compression.py`, stripped there with
 * `content.find(TODO_INJECTION_HEADER)`) and the replayed request onto the
 * summary carrier (`agent/context_compressor.py`
 * `_INFLIGHT_TASK_REPLAY_HEADER`).
 */
const MERGED_HEADERS: readonly string[] = [
  "[Your active task list was preserved across context compression]",
  "[STILL IN PROGRESS",
]

/** Openers of the untyped turns Hermes starts on its own. */
export const AUTOMATION_PREFIXES: readonly string[] = [
  // `hermes_cli/goals.py` `CONTINUATION_PROMPT_*_TEMPLATE`.
  "[Continuing toward your standing goal",
  // `hermes_cli/loops.py` `WAKEUP_PROMPT_TEMPLATE`.
  "[/loop wakeup #",
  // `hermes_cli/heartbeat.py` `HEARTBEAT_PROMPT_TEMPLATE`.
  "[Heartbeat — recurring instruction",
  // Watch matches and untyped completions:
  // `tools/process_registry_notifications.py` `_format_process_notification`.
  "[IMPORTANT: Background process ",
  // Crash-recovery continuation persisted before display typing:
  // `tui_gateway/session_history.py` `_AUTO_CONTINUE_NOTE_PREFIX`.
  "[System note: Your previous turn was interrupted mid-run",
]

/**
 * User-row tags whose turn Hermes started on its own. `hidden` is also
 * Hermes' process-heartbeat wake (`tools/process_registry_notifications.py`
 * `HEARTBEAT_DISPLAY_KIND`, newer than the pinned commit).
 */
const AUTOMATION_KINDS: ReadonlySet<string> = new Set([
  "auto_continue",
  "process_complete",
  "async_delegation_complete",
  "internal_notification",
  "hidden",
])

/**
 * The scaffold Hermes prepends to the `api_content` of the user row an accepted
 * `session.redirect` persists: `agent/conversation_loop.py`
 * `_apply_active_turn_redirect` writes it there while the interrupted turn is
 * still open, so the row is the correction itself rather than a new prompt.
 */
const REDIRECT_SCAFFOLD_PREFIX =
  "[Context from the interrupted assistant response]"

/** The wrapper of a mid-turn `/steer`: `agent/prompt_builder.py` `STEER_MARKER_*`. */
const STEER_OPEN = "[OUT-OF-BAND USER MESSAGE"
const STEER_CLOSE = "[/OUT-OF-BAND USER MESSAGE]"

// A port of `apps/shared/src/skill-scaffold.ts`, whose markers mirror
// `agent/skill_commands.py` byte for byte.
const INVOCATION_PREFIX = "[IMPORTANT: The user has invoked the "
const SINGLE_MARKER = "The full skill content is loaded below.]"
const SINGLE_INSTRUCTION =
  "The user has provided the following instruction alongside the skill invocation: "
const RUNTIME_NOTE = "\n\n[Runtime note:"
const BUNDLE_MARKER = " skill bundle,"
const BUNDLE_INSTRUCTION = "\nUser instruction: "
const BUNDLE_SKILL_BLOCK = "\n\n[Loaded as part of the "
const SKILL_NAME = /^\[IMPORTANT: The user has invoked the "([^"]*)"/u

/** Text between `marker` and `end`, or "" when the marker is absent. */
function between(text: string, marker: string, end: string, fromEnd = false) {
  const index = fromEnd ? text.lastIndexOf(marker) : text.indexOf(marker)
  if (index < 0) return ""
  const tail = text.slice(index + marker.length)
  const stop = tail.indexOf(end)
  return (stop >= 0 ? tail.slice(0, stop) : tail).trim()
}

/**
 * The invocation a skill-expanded turn came from (`/work fix the leak`), or
 * undefined when `text` is ordinary prose.
 */
export function skillInvocationText(text: string): string | undefined {
  if (!text.startsWith(INVOCATION_PREFIX)) return undefined
  const name = (SKILL_NAME.exec(text)?.[1] ?? "").trim()
  if (!name) return undefined
  // A bundle header already carries its typed "/a /b" keys. The single-skill
  // instruction trails the body, which may quote its marker.
  const label = name.startsWith("/") ? name : `/${name}`
  const instruction = text.includes(BUNDLE_MARKER)
    ? between(text, BUNDLE_INSTRUCTION, BUNDLE_SKILL_BLOCK)
    : text.includes(SINGLE_MARKER)
      ? between(text, SINGLE_INSTRUCTION, RUNTIME_NOTE, true)
      : ""
  return instruction ? `${label} ${instruction.replace(/\s+/gu, " ")}` : label
}

/**
 * The operator's words inside a steer wrapper, the way Hermes'
 * `_extract_steer_text_from_message` reads them, or undefined without one.
 */
export function unwrapSteer(text: string): string | undefined {
  const open = text.indexOf(STEER_OPEN)
  if (open < 0) return undefined
  const lineEnd = text.indexOf("\n", open)
  const start = lineEnd < 0 ? open + STEER_OPEN.length : lineEnd + 1
  const end = text.indexOf(STEER_CLOSE, start)
  return end < 0 ? undefined : text.slice(start, end).trim() || undefined
}

/** A row's text before the first scaffold Hermes merged onto it. */
export function stripMergedScaffolding(text: string): string {
  const cut = Math.min(
    ...MERGED_HEADERS.map((header) => text.indexOf(`\n\n${header}`)).filter(
      (index) => index >= 0
    )
  )
  return Number.isFinite(cut) ? text.slice(0, cut).trimEnd() : text
}

/** A mid-turn redirect, which the run journal also acknowledges. */
function isRedirect(row: Record<string, unknown>) {
  return (
    typeof row.api_content === "string" &&
    row.api_content.startsWith(REDIRECT_SCAFFOLD_PREFIX)
  )
}

/** Classifies a stored row, given the text its content derives. */
export function classifyHermesRow(
  row: Record<string, unknown>,
  text: string
): HermesRowClass {
  const kind =
    typeof row.display_kind === "string" ? row.display_kind.trim() : ""
  if (row.role !== "user") return { kind: kind ? "skip" : "prompt", text }
  if (kind === "steer")
    return {
      kind: "correction",
      text: stripMergedScaffolding(unwrapSteer(text) ?? text),
    }
  // A compaction handoff is also tagged `hidden`, and opens nothing.
  if (AUTOMATION_KINDS.has(kind) && row._compressed_summary !== true)
    return { kind: "automation", text }
  if (kind && kind !== "skill_invocation") return { kind: "skip", text }
  const opening = text.trimStart()
  if (
    MODEL_ONLY_PREFIXES.some((prefix) => opening.startsWith(prefix)) ||
    LEGACY_PROCESS_HEARTBEAT.test(opening)
  )
    return { kind: "skip", text }
  if (AUTOMATION_PREFIXES.some((prefix) => opening.startsWith(prefix)))
    return { kind: "automation", text }
  const shown = stripMergedScaffolding(text)
  if (isRedirect(row)) return { kind: "correction", text: shown }
  return {
    kind: "prompt",
    text: skillInvocationText(shown.trimStart()) ?? shown,
  }
}
