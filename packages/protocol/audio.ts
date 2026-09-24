/**
 * The audio envelope every voice implementation answers for: which recording
 * container a browser may upload, which codec parameter it may name, which
 * container speech may come back in, and how large each side may be. A native
 * adapter and a proxy-side provider advertise the same envelope, so the values
 * live here rather than beside either one.
 */

export const RECORDING_MIME_TYPES: readonly string[] = [
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "video/webm",
]

/** Accepted values of the single `codecs` recording MIME parameter. */
export const RECORDING_CODECS: readonly string[] = [
  "aac",
  "flac",
  "mp3",
  "mp4a.40.2",
  "opus",
  "pcm",
  "vorbis",
]

export const SPEECH_MIME_TYPES: readonly string[] = [
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
]

const RECORDING_MIME = new Set(RECORDING_MIME_TYPES)
const RECORDING_CODEC = new Set(RECORDING_CODECS)

/**
 * Splits an uploaded recording's `type[;codecs=value]` into its accepted parts,
 * or nothing when either the container or the codec is not one we take.
 * Case and whitespace around `;` and `=` are tolerated, as MIME allows: iOS
 * Safari labels its recordings `audio/webm; codecs=opus`.
 */
export function parseRecordingMime(
  value: string
): { type: string; codec?: string } | undefined {
  const separator = value.indexOf(";")
  const type = (separator < 0 ? value : value.slice(0, separator))
    .trim()
    .toLowerCase()
  if (!RECORDING_MIME.has(type)) return undefined
  if (separator < 0) return { type }
  const [name, raw, ...rest] = value.slice(separator + 1).split("=")
  if (rest.length > 0 || name?.trim().toLowerCase() !== "codecs")
    return undefined
  const codec = raw?.trim().toLowerCase()
  return codec && RECORDING_CODEC.has(codec) ? { type, codec } : undefined
}

export const MAX_RECORDING_BYTES = 5 * 1024 * 1024
export const MAX_TRANSCRIPT_BYTES = 1_000_000
export const MAX_SPEECH_TEXT_BYTES = 32_000
export const MAX_SPEECH_BYTES = 20 * 1024 * 1024
