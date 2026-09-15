import { createHash } from "node:crypto"

type HermesMediaArtifact = {
  reference: string
  descriptor: {
    id: string
    filename: string
    mimeType: string
    source: { type: "provider"; reference: string }
  }
}

const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
}

const MEDIA_LINE =
  /^\s*MEDIA:\s*(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s*$/u
const MEDIA_DIRECTIVE_PREFIX = /^\s*MEDIA:/u
const POSSIBLE_MEDIA_PREFIX =
  /^\s*(?:M(?:E(?:D(?:I(?:A(?::(?:\s*)?)?)?)?)?)?)?$/u
const MAX_MEDIA_LINE_BYTES = 4_112

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parsedRecord(value: unknown) {
  if (typeof value !== "string") return isRecord(value) ? value : undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function mediaReference(line: string) {
  return MEDIA_LINE.exec(line)?.slice(1).find(Boolean)
}

function safeAudioReference(reference: string) {
  if (
    reference !== reference.trim() ||
    !reference ||
    Buffer.byteLength(reference, "utf8") > 4_096 ||
    [...reference].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    return undefined
  const filename = reference.split(/[\\/]/u).at(-1)
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    Buffer.byteLength(filename, "utf8") > 255
  )
    return undefined
  const extension = filename.match(/\.([A-Za-z0-9]+)$/u)?.[1]?.toLowerCase()
  const mimeType = extension ? AUDIO_MIME_BY_EXTENSION[extension] : undefined
  return mimeType ? { filename, mimeType } : undefined
}

function resultReferences(result: Record<string, unknown>) {
  const values = [
    ...(typeof result.file_path === "string" ? [result.file_path] : []),
    ...(Array.isArray(result.file_paths)
      ? result.file_paths.filter(
          (value): value is string => typeof value === "string"
        )
      : []),
  ]
  return new Set(values)
}

function taggedReferences(result: Record<string, unknown>) {
  if (typeof result.media_tag !== "string") return new Set<string>()
  return new Set(
    result.media_tag
      .split(/\r?\n/u)
      .flatMap((line) => mediaReference(line) ?? [])
  )
}

function artifactId(toolCallId: string, reference: string) {
  const digest = createHash("sha256")
    .update(toolCallId)
    .update("\0")
    .update(reference)
    .digest("hex")
    .slice(0, 32)
  return `hermes-media-${digest}`
}

/**
 * Grants artifact authority only to audio paths repeated in a successful,
 * native Hermes TTS receipt. Assistant-authored MEDIA text is never authority.
 */
export function projectHermesMediaArtifacts(
  toolCallId: string,
  toolName: string,
  raw: unknown
): HermesMediaArtifact[] {
  if (toolName !== "text_to_speech" || !toolCallId) return []
  const result = parsedRecord(raw)
  if (!result || result.success !== true) return []
  const emitted = resultReferences(result)
  const tagged = taggedReferences(result)
  const seen = new Set<string>()
  const artifacts: HermesMediaArtifact[] = []
  for (const reference of emitted) {
    if (!tagged.has(reference) || seen.has(reference)) continue
    seen.add(reference)
    const audio = safeAudioReference(reference)
    if (!audio) continue
    const id = artifactId(toolCallId, reference)
    artifacts.push({
      reference,
      descriptor: {
        id,
        ...audio,
        source: { type: "provider", reference: id },
      },
    })
  }
  return artifacts
}

/** Incrementally removes Hermes delivery directives without exposing paths. */
export class HermesMediaTextFilter {
  #pending = ""
  #discardingMediaLine = false
  readonly #trusted = new Set<string>()

  constructor(trustedReferences: Iterable<string> = []) {
    for (const reference of trustedReferences) this.#trusted.add(reference)
  }

  trust(reference: string) {
    this.#trusted.add(reference)
  }

  write(value: string) {
    let prefix = ""
    if (this.#discardingMediaLine) {
      const newline = value.indexOf("\n")
      if (newline < 0) return ""
      this.#discardingMediaLine = false
      value = value.slice(newline + 1)
      prefix = "\n"
    }
    this.#pending += value
    return `${prefix}${this.#drain(false)}`
  }

  finish() {
    this.#discardingMediaLine = false
    return this.#drain(true)
  }

  #projectLine(line: string) {
    const reference = mediaReference(line)
    if (!reference) return line
    return this.#trusted.size > 0 ? "" : "[Media unavailable]"
  }

  #drain(final: boolean) {
    let output = ""
    while (this.#pending) {
      const newline = this.#pending.indexOf("\n")
      if (newline >= 0) {
        const line = this.#pending.slice(0, newline).replace(/\r$/u, "")
        this.#pending = this.#pending.slice(newline + 1)
        const projected = this.#projectLine(line)
        if (projected) output += `${projected}\n`
        continue
      }
      if (
        !final &&
        (POSSIBLE_MEDIA_PREFIX.test(this.#pending) ||
          MEDIA_DIRECTIVE_PREFIX.test(this.#pending))
      ) {
        if (Buffer.byteLength(this.#pending, "utf8") <= MAX_MEDIA_LINE_BYTES)
          break
        output += "[Media unavailable]"
        this.#pending = ""
        this.#discardingMediaLine = true
        break
      }
      output += this.#projectLine(this.#pending)
      this.#pending = ""
    }
    return output
  }
}

export function projectHermesMediaText(
  text: string,
  trustedReferences: Iterable<string>
) {
  const filter = new HermesMediaTextFilter(trustedReferences)
  return `${filter.write(text)}${filter.finish()}`.replace(/\n$/u, "")
}
