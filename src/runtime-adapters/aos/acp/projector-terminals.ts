/**
 * The terminal half of the ACP session projector. ACP carries terminal output
 * as base64 bytes: a `terminal_update` snapshot replaces them, and each
 * `terminal_output_chunk` appends. One decoder per terminal reads its bytes as
 * one UTF-8 stream, so a character split across two chunks survives, and only
 * the tail a reader can use is kept.
 */

/** How much output one terminal keeps, in UTF-16 code units. */
export const TERMINAL_TAIL_LIMIT = 256 * 1024

/** What a tool call shows of one terminal. */
export type ProjectedTerminal = {
  readonly terminalId: string
  readonly command?: string
  readonly cwd?: string
  readonly output: string
  /** The output lost its head to the tail limit. */
  readonly truncated?: boolean
  /** The terminal reported how it ended. */
  readonly exited: boolean
  readonly exitCode?: number | null
  readonly signal?: string | null
}

/**
 * The decoder is the one mutable piece: it holds the bytes of a character the
 * last chunk split, so every chunk has to reach it exactly once, in order.
 */
export type TerminalStream = {
  readonly view: ProjectedTerminal
  readonly decoder: TextDecoder
}

export type TerminalSnapshot = {
  readonly command?: unknown
  readonly cwd?: unknown
  readonly output?: unknown
  readonly exitStatus?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function bytesOf(data: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** The tail within the limit, never starting on half a surrogate pair. */
function tail(output: string): { output: string; truncated?: true } {
  if (output.length <= TERMINAL_TAIL_LIMIT) return { output }
  const cut = output.slice(-TERMINAL_TAIL_LIMIT)
  const first = cut.charCodeAt(0)
  const low = first >= 0xdc00 && first <= 0xdfff
  return { output: low ? cut.slice(1) : cut, truncated: true }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Omitted keeps, `null` clears, a string replaces. */
function patchText(
  view: Mutable<ProjectedTerminal>,
  key: "command" | "cwd",
  value: unknown
) {
  if (value === null) delete view[key]
  else if (typeof value === "string") view[key] = value
}

/** Applies a `terminal_update`; output it carries replaces what was there. */
export function snapshotTerminal(
  current: TerminalStream | undefined,
  terminalId: string,
  snapshot: TerminalSnapshot
): TerminalStream {
  const view: Mutable<ProjectedTerminal> = {
    ...(current?.view ?? { terminalId, output: "", exited: false }),
  }
  let decoder = current?.decoder ?? new TextDecoder()
  const { output, exitStatus } = snapshot
  const bytes =
    isRecord(output) && typeof output.data === "string"
      ? bytesOf(output.data)
      : undefined
  if (bytes) {
    decoder = new TextDecoder()
    delete view.truncated
    Object.assign(view, tail(decoder.decode(bytes, { stream: true })))
  }
  patchText(view, "command", snapshot.command)
  patchText(view, "cwd", snapshot.cwd)
  if (exitStatus === null) {
    view.exited = false
    delete view.exitCode
    delete view.signal
  } else if (isRecord(exitStatus)) {
    view.exited = true
    const { exitCode, signal } = exitStatus
    if (typeof exitCode === "number" || exitCode === null)
      view.exitCode = exitCode
    if (typeof signal === "string" || signal === null) view.signal = signal
  }
  return { view, decoder }
}

/** Applies a `terminal_output_chunk`; undecodable data changes nothing. */
export function appendTerminal(
  current: TerminalStream | undefined,
  terminalId: string,
  data: string
): TerminalStream | undefined {
  const bytes = bytesOf(data)
  if (!bytes) return undefined
  const stream = current ?? snapshotTerminal(undefined, terminalId, {})
  const { view, decoder } = stream
  const next = tail(view.output + decoder.decode(bytes, { stream: true }))
  return {
    decoder,
    view: {
      ...view,
      ...next,
      ...(view.truncated ? { truncated: true } : {}),
    },
  }
}
