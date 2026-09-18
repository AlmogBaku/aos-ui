/**
 * The turn Hermes retains outside its transcript.
 *
 * Hermes does not persist a turn that ended in a provider error: it keeps the
 * prompt, whatever assistant text it streamed and its own classification in the
 * Session's inflight snapshot. Only `session.resume` returns that snapshot; the
 * authoritative history route does not carry it. Hermes Desktop rebuilds the
 * failed turn from it, so an AOS history load does the same here, publishing the
 * very failure the live run engine would have published: the same headline and
 * the same bounded native cause.
 *
 * Upstream `InflightTurn` (contract commit in UPSTREAM.md) carries `assistant`,
 * `streaming`, `user`, `corrections`, `correction_offsets`, `error`, `status`,
 * `recoverable` and `error_surface`; nothing outside the fields validated below
 * is read.
 */
import type { SessionMessage } from "../../../protocol"

import { projectHermesMediaText } from "./media-artifacts"
import { isRecord, nativeId } from "./native"
import { boundedText } from "./run-frames"
import { nativeFailure, publicRunFailure } from "./run-failures"

/** The only `error_surface` fields AOS reads, as strings or booleans. */
const SURFACE_FIELDS = [
  "layer",
  "code",
  "retryable",
  "provider",
  "model",
] as const

type SurfaceField = (typeof SURFACE_FIELDS)[number]

/**
 * The protocol bounds one text part in characters while every native text bound
 * here is in bytes, so a retained turn inside the byte bound can still exceed it.
 */
const MAX_TEXT_PART_CHARACTERS = 1_000_000

/** Hermes' retained turn, validated and bounded. */
export type HermesInflightTurn = {
  /** Hermes' own turn state, typically `error` for a retained failed turn. */
  readonly status?: string
  /** Whether Hermes is still streaming this turn, for AOS or for another client. */
  readonly streaming?: boolean
  /** The prompt the retained turn answers. */
  readonly user?: string
  /** The assistant text Hermes streamed before the turn failed. */
  readonly assistant?: string
  readonly errorSurface?: Readonly<
    Partial<Record<SurfaceField, string | boolean>>
  >
  /** Hermes' own error text, published only as a bounded, redacted detail. */
  readonly error?: string
}

function surfaceFields(value: unknown) {
  if (!isRecord(value)) return undefined
  const fields: Partial<Record<SurfaceField, string | boolean>> = {}
  for (const key of SURFACE_FIELDS) {
    const field = value[key]
    if (typeof field === "boolean") fields[key] = field
    else {
      const text = nativeId(field, 512)
      if (text !== undefined) fields[key] = text
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}

/** Read the retained turn out of a `session.resume` payload. */
export function hermesInflightTurn(
  value: unknown
): HermesInflightTurn | undefined {
  if (!isRecord(value)) return undefined
  const status = nativeId(value.status, 64)
  const streaming =
    typeof value.streaming === "boolean" ? value.streaming : undefined
  const user = boundedText(value.user)
  const assistant = boundedText(value.assistant)
  const errorSurface = surfaceFields(value.error_surface)
  const error = boundedText(value.error)
  return {
    ...(status !== undefined ? { status } : {}),
    ...(streaming !== undefined ? { streaming } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(assistant !== undefined ? { assistant } : {}),
    ...(errorSurface ? { errorSurface } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

/**
 * True when the retained turn failed rather than being still in flight. Only
 * Hermes' own turn state says so: an `error` text survives in the snapshot of a
 * turn that is still streaming (Hermes Desktop may be driving it), and a history
 * load must never restore a failed bubble over a turn nobody failed.
 */
export function inflightTurnFailed(inflight: HermesInflightTurn) {
  return inflight.status === "error" && inflight.streaming !== true
}

/**
 * The retained turn must answer the prompt the transcript ends with. Hermes
 * keeps the whole native prompt, whose attached-context block the public
 * transcript projection strips, so the public text may be a prefix of it.
 */
function answersPrompt(native: string | undefined, publicText: string) {
  const prompt = native?.trim()
  const text = publicText.trim()
  return prompt !== undefined && text.length > 0 && prompt.startsWith(text)
}

/**
 * The assistant message a history load appends for a retained failed turn, or
 * nothing when the snapshot describes no failure of that prompt. The failure is
 * the run-failure catalogue's own, so a restored turn reads exactly as the live
 * turn read before the reload.
 */
export function restoredHermesFailedTurn(
  inflight: HermesInflightTurn,
  turn: { id: string; userText: string; createdAt: string }
): SessionMessage | undefined {
  if (!inflightTurnFailed(inflight)) return undefined
  if (!answersPrompt(inflight.user, turn.userText)) return undefined
  const { code, message } = publicRunFailure(
    nativeFailure({
      ...(inflight.errorSurface
        ? { error_surface: inflight.errorSurface }
        : {}),
      ...(inflight.error !== undefined ? { error: inflight.error } : {}),
    })
  )
  // Only prose Hermes actually streamed is content: a turn that streamed
  // nothing before failing restores as the failure alone, exactly as the live
  // turn published it. A restore also trusts no media reference, because
  // nothing published a tool result for this turn.
  // Truncated, never refused: an oversized retained turn must not fail the
  // whole history load on the protocol's character bound.
  const text = (
    inflight.assistant === undefined
      ? ""
      : projectHermesMediaText(inflight.assistant, [])
  ).slice(0, MAX_TEXT_PART_CHARACTERS)
  return {
    id: turn.id,
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    createdAt: turn.createdAt,
    status: { type: "incomplete", reason: "error", error: message },
    metadata: { custom: { aos: { runErrorCode: code } } },
  }
}
