/**
 * Sequenced native-event frame builders.
 *
 * `nativeTurn` returns a stateful builder whose sequence counter advances with
 * each frame call.  Call it once per logical turn in a test; restart a new
 * builder for a second turn if you need independent sequencing.
 *
 * Field names match what run.ts actually reads:
 *   message_id, text, already_streamed, tool_id, name, args, result,
 *   is_error, status, running
 *
 * Canned sequences correspond to the turn shapes named in TURN-LIFECYCLE.md.
 */

export type NativeFrame = {
  type: string
  session_id: string
  seq: number
  payload?: Record<string, unknown>
}

export type NativeTurnBuilder = {
  /** Build an arbitrary frame; advances the sequence counter. */
  frame(type: string, payload?: Record<string, unknown>): NativeFrame
  /** `message.start` with the given message_id */
  messageStart(id: string): NativeFrame
  /** `message.delta` with text */
  delta(text: string): NativeFrame
  /**
   * `message.interim` — seals the current streaming segment.
   * Pass `alreadyStreamed = true` when the text was already sent via deltas.
   */
  interim(text: string, alreadyStreamed: boolean): NativeFrame
  /** `tool.start` */
  toolStart(
    toolId: string,
    name: string,
    args?: Record<string, unknown>
  ): NativeFrame
  /** `tool.complete` */
  toolComplete(
    toolId: string,
    name: string,
    result: unknown,
    isError?: boolean
  ): NativeFrame
  /** `message.complete` */
  complete(
    id: string,
    text: string,
    status?: "complete" | "error" | "interrupted"
  ): NativeFrame
  /** `session.info` with `running: false` */
  idle(): NativeFrame
  /** Generic `error` event (advisory or terminal after idle) */
  error(message: string): NativeFrame
}

export function nativeTurn(
  liveSessionId = "live-secret",
  startSeq = 1
): NativeTurnBuilder {
  let seq = startSeq

  const frame = (
    type: string,
    payload?: Record<string, unknown>
  ): NativeFrame => ({
    type,
    session_id: liveSessionId,
    seq: seq++,
    ...(payload !== undefined ? { payload } : {}),
  })

  return {
    frame,
    messageStart: (id) => frame("message.start", { message_id: id }),
    delta: (text) => frame("message.delta", { text }),
    interim: (text, already_streamed) =>
      frame("message.interim", { text, already_streamed }),
    toolStart: (tool_id, name, args = {}) =>
      frame("tool.start", { tool_id, name, args }),
    toolComplete: (tool_id, name, result, is_error?) =>
      frame("tool.complete", {
        tool_id,
        name,
        result,
        ...(is_error !== undefined ? { is_error } : {}),
      }),
    complete: (message_id, text, status = "complete") =>
      frame("message.complete", { message_id, text, status }),
    idle: () => frame("session.info", { running: false }),
    error: (message) => frame("error", { message }),
  }
}

// ---------------------------------------------------------------------------
// Canned sequences from TURN-LIFECYCLE.md
// ---------------------------------------------------------------------------

/**
 * A turn that contains a failed tool, interim assistant commentary, successful
 * tools, and a successful completion.  Hermes does NOT end the turn at the
 * failed tool; the run must stay open until `message.complete`.
 *
 * Sequence:
 *   message.start
 *   tool.start  (skill_view)
 *   tool.complete (skill_view, failed)
 *   message.interim ("I will try another approach.")
 *   tool.start  (read_file)
 *   tool.complete (read_file, success)
 *   message.complete (status=complete)
 *   session.info (running=false)
 */
export function failedToolThenRecovery(
  liveSessionId = "live-secret",
  startSeq = 1
): NativeFrame[] {
  const t = nativeTurn(liveSessionId, startSeq)
  return [
    t.messageStart("msg-ftr"),
    t.toolStart("tool-fail", "skill_view", { name: "missing" }),
    t.toolComplete("tool-fail", "skill_view", { error: "not found" }, true),
    t.interim("I will try another approach.", false),
    t.toolStart("tool-ok", "read_file", { path: "notes.md" }),
    t.toolComplete("tool-ok", "read_file", "file contents"),
    t.complete("msg-ftr", "Here is what I found."),
    t.idle(),
  ]
}

/**
 * A turn that receives an advisory `error` event while the session is still
 * running (e.g. a rejected model switch), followed by tool work and a
 * successful completion.
 *
 * **Status precondition:** the `native.status()` stub must return `"running"`
 * (not `"idle"` or `"absent"`) when the `error` frame arrives.  With an idle
 * status the error handler in `run.ts` will call `#settleFrom(idle)` and
 * fail the run rather than treating the error as advisory.
 *
 * Sequence:
 *   message.start
 *   error (advisory, e.g. model switch failure)
 *   tool.start
 *   tool.complete
 *   message.complete (status=complete)
 *   session.info (running=false)
 */
export function advisoryErrorThenComplete(
  liveSessionId = "live-secret",
  startSeq = 1
): NativeFrame[] {
  const t = nativeTurn(liveSessionId, startSeq)
  return [
    t.messageStart("msg-aec"),
    t.error("model switch rejected; continuing with current model"),
    t.toolStart("tool-1", "read_file", { path: "data.csv" }),
    t.toolComplete("tool-1", "read_file", "1,2,3"),
    t.complete("msg-aec", "Done."),
    t.idle(),
  ]
}

/**
 * A turn that ends with a terminal `error` status in `message.complete`
 * followed by the expected idle `session.info`.  The run must fail.
 *
 * Sequence:
 *   message.start
 *   message.delta (partial text)
 *   message.complete (status=error)
 *   session.info (running=false)
 */
export function terminalErrorThenIdle(
  liveSessionId = "live-secret",
  startSeq = 1
): NativeFrame[] {
  const t = nativeTurn(liveSessionId, startSeq)
  return [
    t.messageStart("msg-tei"),
    t.delta("Partial response before"),
    t.complete("msg-tei", "Partial response before", "error"),
    t.idle(),
  ]
}
