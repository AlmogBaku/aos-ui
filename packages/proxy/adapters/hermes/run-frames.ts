/**
 * Reading native Hermes frames.
 *
 * A frame arrives as unvalidated native JSON, so every reader here is total: it
 * answers with a value the run may act on or with nothing at all. Nothing in
 * this module knows what a run does with a frame, and nothing in it can emit.
 */
import type { TokenUsage } from "../../core/events"

import {
  boundedNativeBytes,
  isRecord,
  nativeId,
  utf8BytesWithin,
} from "./native"

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
} as const

/** A native usage payload is accepted whole or not at all. */
export function tokenUsage(value: unknown): TokenUsage[] | undefined {
  if (!isRecord(value)) return undefined
  if (value.model !== undefined && !stableNativeId(value.model))
    return undefined
  const model = stableNativeId(value.model)
  const usage: TokenUsage = model ? { model } : {}
  for (const [key, field] of Object.entries(TOKEN_USAGE_FIELDS)) {
    const count = value[key]
    if (count === undefined) continue
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      return undefined
    usage[field] = count
  }
  return Object.keys(usage).length > 0 ? [usage] : undefined
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
