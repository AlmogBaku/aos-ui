/**
 * Reading native Hermes frames.
 *
 * A frame arrives as unvalidated native JSON, so every reader here is total: it
 * answers with a value the run may act on or with nothing at all. Nothing in
 * this module knows what a run does with a frame, and nothing in it can emit.
 */
import {
  SubagentStatus,
  type Cost,
  type Subagent,
  type TokenUsage,
} from "../../core/events"

import {
  boundedNativeBytes,
  isRecord,
  nativeId,
  parseJsonOrValue,
  utf8BytesWithin,
} from "./native"
import { publicPath, stringContainsCredential } from "./tool-data"

const MAX_NATIVE_TEXT_DELTA_BYTES = 1_048_576
const MAX_PREACTIVE_EVENTS = 4_096
const MAX_PREACTIVE_BYTES = 4_194_304

export type HermesNativeEvent = {
  type: string
  session_id: string
  seq?: number
  payload?: unknown
}

/** One page of the frames Hermes' own ring still retains. */
export type HermesRecovery = {
  epoch: string
  lastSeen: number
  truncated?: boolean
  events: readonly unknown[]
}

/** Native frames held back, bounded in both count and bytes. */
export type BufferedNativeEvents = {
  events: unknown[]
  bytes: number
  overflow: boolean
}

export function nativeEvent(value: unknown): HermesNativeEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const event = value as Record<string, unknown>
  if (typeof event.type !== "string" || typeof event.session_id !== "string")
    return undefined
  if (
    event.seq !== undefined &&
    (typeof event.seq !== "number" ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0)
  )
    return undefined
  return {
    type: event.type,
    session_id: event.session_id,
    ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
    ...(event.payload !== undefined ? { payload: event.payload } : {}),
  }
}

export function nativeEventSessionId(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  try {
    return stableNativeId((value as Record<string, unknown>).session_id)
  } catch {
    return undefined
  }
}

export function payloadOf(event: HermesNativeEvent) {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : {}
}

export function stableNativeId(value: unknown) {
  return nativeId(value, 512)
}

export function boundedText(value: unknown) {
  return typeof value === "string" &&
    utf8BytesWithin(value, MAX_NATIVE_TEXT_DELTA_BYTES) !== undefined
    ? value
    : undefined
}

/** Hermes' token counter names, as AOS token usage fields. */
const TOKEN_USAGE_FIELDS = {
  input: "inputTokens",
  output: "outputTokens",
  reasoning: "reasoningTokens",
  total: "totalTokens",
  cache_read: "cachedInputTokens",
  cache_write: "cachedWriteTokens",
} as const

/**
 * A native usage payload is accepted whole or not at all. Hermes sends `null`
 * for a counter it does not track, which reads as absent.
 */
export function tokenUsage(value: unknown): TokenUsage[] | undefined {
  if (!isRecord(value)) return undefined
  if (value.model !== undefined && !stableNativeId(value.model))
    return undefined
  const model = stableNativeId(value.model)
  const usage: TokenUsage = model ? { model } : {}
  for (const [key, field] of Object.entries(TOKEN_USAGE_FIELDS)) {
    const count = value[key]
    if (count === undefined || count === null) continue
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      return undefined
    usage[field] = count
  }
  return Object.keys(usage).length > 0 ? [usage] : undefined
}

/** What a native usage payload priced the Session at, in US dollars. */
export function usageCost(value: unknown): Cost | undefined {
  if (!isRecord(value)) return undefined
  const amount = value.cost_usd
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0
    ? { amount, currency: "USD" }
    : undefined
}

/** Hermes reports a span in seconds; AOS carries whole milliseconds. */
export function durationMs(seconds: unknown) {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * 1000)
    : undefined
}

/**
 * The process a backgrounded `terminal` call left running. Hermes names it
 * `session_id` in the result, and `process_id` on every frame it streams.
 */
export function backgroundProcessId(result: unknown) {
  const value = parseJsonOrValue(result)
  return isRecord(value) ? stableNativeId(value.session_id) : undefined
}

// CSI and OSC sequences, which a terminal renders rather than prints.
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/gu

/** A terminal chunk as the plain text it prints. */
export function terminalText(chunk: string) {
  return chunk.replace(ANSI_SEQUENCES, "")
}

/** Hermes' subagent lifecycle, as AOS subagent status. */
const SUBAGENT_STATUSES: Record<string, SubagentStatus> = {
  queued: SubagentStatus.Running,
  running: SubagentStatus.Running,
  completed: SubagentStatus.Completed,
  failed: SubagentStatus.Failed,
  error: SubagentStatus.Failed,
  timeout: SubagentStatus.Failed,
  interrupted: SubagentStatus.Cancelled,
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function publicProse(value: unknown) {
  const text = boundedText(value)
  return text && !stringContainsCredential(text) ? text : undefined
}

function publicPaths(value: unknown) {
  return Array.isArray(value) ? value.filter(publicPath) : undefined
}

/**
 * The patch a `subagent.*` frame reports about a subagent the turn itself
 * spawned. Hermes counts depth from 0 for such a child; a deeper one was spawned
 * by a call inside another subagent, which this turn never saw start.
 */
export function subagentPatch(
  type: string,
  payload: Record<string, unknown>
): Subagent | undefined {
  const id = stableNativeId(payload.subagent_id)
  if (!id || (payload.depth ?? 0) !== 0) return undefined
  const input = count(payload.input_tokens)
  const output = count(payload.output_tokens)
  const status =
    SUBAGENT_STATUSES[String(payload.status)] ??
    (type === "subagent.start" ? SubagentStatus.Running : undefined)
  const patch = {
    id,
    goal: publicProse(payload.goal),
    model: stableNativeId(payload.model),
    depth: 1,
    status,
    // Hermes' own readouts total a Session as its input and output tokens.
    tokens:
      input === undefined && output === undefined
        ? undefined
        : (input ?? 0) + (output ?? 0),
    filesRead: publicPaths(payload.files_read),
    filesWritten: publicPaths(payload.files_written),
    durationMs: durationMs(payload.duration_seconds),
    childSessionId: stableNativeId(payload.child_session_id),
    summary: publicProse(payload.summary),
  }
  // Every report restates only what this frame carries.
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Subagent
}

export function nativeEventBuffer(): BufferedNativeEvents {
  return { events: [], bytes: 0, overflow: false }
}

export function bufferNativeEvent(
  buffer: BufferedNativeEvents,
  value: unknown
) {
  if (buffer.overflow) return
  const bytes = boundedNativeBytes(value, MAX_PREACTIVE_BYTES - buffer.bytes)
  if (bytes === undefined || buffer.events.length >= MAX_PREACTIVE_EVENTS) {
    buffer.overflow = true
    buffer.events.splice(0, buffer.events.length)
    buffer.bytes = 0
    return
  }
  buffer.events.push(value)
  buffer.bytes += bytes
}

export function drainBufferedEvents(buffer: BufferedNativeEvents) {
  const events = buffer.events.splice(0, buffer.events.length)
  buffer.bytes = 0
  return events
}

/**
 * The sequence a catch-up has to reach for the held frames to continue the run.
 * Nothing held (an ordinary heal that missed no frame) demands nothing.
 */
export function firstBufferedSeq(events: readonly unknown[]) {
  for (const value of events) {
    const seq = nativeEvent(value)?.seq
    if (seq !== undefined) return seq
  }
  return 0
}
