import { createHash } from "node:crypto"
import { isRecord } from "./native"

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
    return this.#trusted.size > 0 ? undefined : "[Media unavailable]"
  }

  #drain(final: boolean) {
    let output = ""
    while (this.#pending) {
      const newline = this.#pending.indexOf("\n")
      if (newline >= 0) {
        const line = this.#pending.slice(0, newline).replace(/\r$/u, "")
        this.#pending = this.#pending.slice(newline + 1)
        const projected = this.#projectLine(line)
        if (projected !== undefined) output += `${projected}\n`
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
      output += this.#projectLine(this.#pending) ?? ""
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

// ---------------------------------------------------------------------------
// Published `aos.artifact` receipts
// ---------------------------------------------------------------------------

const credentialValue =
  /(?:\b(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credential|password|secret|token)\s*[=:]\s*\S+|\b(?:basic|bearer)\s+\S+|\b(?:gh[opsur]_\w+|sk-[\w-]+|xox[baprs]-\w+|eyJ[\w-]+\.[\w-]+\.[\w-]+))/iu
const privateLocationValue =
  /(?:^|[\s("'=])(?:\/(?:etc|home|root|srv|tmp|var)\/|[A-Za-z]:\\|file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s]*(?:hermes|internal|\.local))(?:[/:]|$))/iu

/**
 * True when a native string looks like a credential or a private filesystem or
 * internal-network location. Shared by artifact receipts and history tool
 * projection so one rule decides what may leave the adapter.
 */
export function containsPrivateValue(value: string) {
  return credentialValue.test(value) || privateLocationValue.test(value)
}

function trimmedString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function safeArtifactToken(value: string, maxLength: number) {
  return (
    value.length <= maxLength &&
    !/[\\/]/u.test(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    }) &&
    value !== "." &&
    value !== ".." &&
    !containsPrivateValue(value)
  )
}

/**
 * Project a native `present_artifact` receipt into the public opaque artifact
 * descriptor. The native path never leaves this function; the public reference
 * is the artifact id the content operations resolve back to a path.
 */
export function projectHermesArtifactReceipt(raw: unknown) {
  const value = parsedRecord(raw)
  if (!value || value.ok !== true || value.type !== "aos.artifact")
    return undefined
  const artifact = value.artifact
  if (!isRecord(artifact)) return undefined
  const id = trimmedString(artifact.id)
  const filename = trimmedString(artifact.filename)
  const mimeType = trimmedString(artifact.mimeType)
  const sizeBytes = artifact.sizeBytes
  if (
    !id ||
    !filename ||
    !safeArtifactToken(id, 256) ||
    !safeArtifactToken(filename, 255) ||
    (mimeType !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(
        mimeType
      )) ||
    (sizeBytes !== undefined &&
      (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0))
  )
    return undefined
  const descriptor = {
    id,
    filename,
    ...(mimeType ? { mimeType } : {}),
    ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
  }
  return {
    result: { ok: true, type: "aos.artifact", artifact: descriptor },
    part: {
      type: "data" as const,
      name: "aos.artifact",
      data: {
        ...descriptor,
        source: { type: "provider", reference: id },
      },
    },
  }
}

/**
 * Resolve one already-published artifact id to its native reference by scanning
 * authoritative history newest-first. Only a native tool receipt grants
 * authority; a relative, traversal-free path is the sole accepted reference.
 */
export function publishedArtifact(
  rows: readonly unknown[],
  artifactId: string
) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!isRecord(row)) continue
    if (row.role === "tool") {
      const toolCallId = trimmedString(row.tool_call_id ?? row.toolCallId)
      const toolName = trimmedString(row.tool_name ?? row.toolName)
      if (toolCallId && toolName)
        for (const media of projectHermesMediaArtifacts(
          toolCallId,
          toolName,
          row.content ?? row.result
        ))
          if (media.descriptor.id === artifactId)
            return {
              reference: media.reference,
              filename: media.descriptor.filename,
            }
    }
    const value = parsedRecord(row.content ?? row.result)
    if (!value || value.ok !== true || value.type !== "aos.artifact") continue
    const artifact = isRecord(value.artifact) ? value.artifact : undefined
    const id = trimmedString(artifact?.id)
    const reference = trimmedString(artifact?.path)
    const filename = trimmedString(artifact?.filename)
    if (
      id !== artifactId ||
      !reference ||
      !filename ||
      reference.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(reference) ||
      reference.split(/[\\/]/u).includes("..")
    )
      continue
    return { reference, filename }
  }
  return undefined
}
