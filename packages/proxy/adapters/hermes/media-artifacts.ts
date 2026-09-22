import { createHash } from "node:crypto"
import {
  containsPrivateValue,
  isRecord,
  parseJson,
  parseJsonOrValue,
  rowText,
  trimmedText,
  utf8BytesWithin,
} from "./native"

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

/** The image types Hermes itself accepts for an attachment upload. */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

const MEDIA_LINE =
  /^\s*MEDIA:\s*(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s*$/u
const MEDIA_DIRECTIVE_PREFIX = /^\s*MEDIA:/u
const POSSIBLE_MEDIA_PREFIX =
  /^\s*(?:M(?:E(?:D(?:I(?:A(?::(?:\s*)?)?)?)?)?)?)?$/u
const MAX_MEDIA_LINE_BYTES = 4_112

function parsedRecord(value: unknown) {
  const parsed = parseJson(value)
  return isRecord(parsed) ? parsed : undefined
}

function mediaReference(line: string) {
  return MEDIA_LINE.exec(line)?.slice(1).find(Boolean)
}

/**
 * The public filename and media type of a native reference, or `undefined` when
 * the reference is unusable or names a type the given map does not cover. One
 * rule for every media kind: the native path itself never becomes public.
 */
function safeMediaReference(
  reference: string,
  mimeByExtension: Readonly<Record<string, string>>
) {
  if (
    reference !== reference.trim() ||
    !reference ||
    utf8BytesWithin(reference, 4_096) === undefined ||
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
    utf8BytesWithin(filename, 255) === undefined
  )
    return undefined
  const extension = filename.match(/\.([A-Za-z0-9]+)$/u)?.[1]?.toLowerCase()
  const mimeType = extension ? mimeByExtension[extension] : undefined
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

function artifactId(scope: string, reference: string) {
  const digest = createHash("sha256")
    .update(scope)
    .update("\0")
    .update(reference)
    .digest("hex")
    .slice(0, 32)
  return `hermes-media-${digest}`
}

/**
 * One opaque artifact over a native reference. The public `source.reference` is
 * the artifact id, never the path, so a content read resolves the path back from
 * authoritative history instead of trusting the browser for it.
 */
function mediaArtifact(
  scope: string,
  reference: string,
  media: { filename: string; mimeType: string }
): HermesMediaArtifact {
  const id = artifactId(scope, reference)
  return {
    reference,
    descriptor: { id, ...media, source: { type: "provider", reference: id } },
  }
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
    const audio = safeMediaReference(reference, AUDIO_MIME_BY_EXTENSION)
    if (!audio) continue
    artifacts.push(mediaArtifact(toolCallId, reference, audio))
  }
  return artifacts
}

// ---------------------------------------------------------------------------
// Attached images on a durable user row
// ---------------------------------------------------------------------------

/**
 * Hermes persists an uploaded image as an `@image:<path>` directive line on the
 * user row it was sent with (`tui_gateway/session_history.py`). The line is
 * native authority for bytes the provider still holds, and never text an
 * operator should read: it names a gateway-local path.
 */
const IMAGE_DIRECTIVE_LINE =
  /^\s*@image:(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s*$/u

/** The scope every attached-image id is derived under; no tool call owns one. */
const ATTACHED_IMAGE_SCOPE = "hermes:attached-image"

/**
 * Split a durable user row's text into the prose the operator wrote and the
 * images it attached. Every directive line leaves the text whether or not its
 * reference is usable, so a marker never reaches the browser as prose.
 */
export function projectHermesAttachedImages(text: string) {
  const prose: string[] = []
  const artifacts: HermesMediaArtifact[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/u)) {
    const reference = IMAGE_DIRECTIVE_LINE.exec(line)?.slice(1).find(Boolean)
    if (reference === undefined) {
      prose.push(line)
      continue
    }
    const image = safeMediaReference(reference, IMAGE_MIME_BY_EXTENSION)
    if (!image || seen.has(reference)) continue
    seen.add(reference)
    artifacts.push(mediaArtifact(ATTACHED_IMAGE_SCOPE, reference, image))
  }
  return { text: prose.join("\n").trim(), artifacts }
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
        if (utf8BytesWithin(this.#pending, MAX_MEDIA_LINE_BYTES) !== undefined)
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
  const id = trimmedText(artifact.id)
  const filename = trimmedText(artifact.filename)
  const mimeType = trimmedText(artifact.mimeType)
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
      const toolCallId = trimmedText(row.tool_call_id ?? row.toolCallId)
      const toolName = trimmedText(row.tool_name ?? row.toolName)
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
    // The directive the operator's own turn persisted is authority for the image
    // it attached: only a reference this Session's transcript still carries can
    // be read back.
    if (row.role === "user" && !trimmedText(row.display_kind))
      for (const image of projectHermesAttachedImages(
        rowText(row, parseJsonOrValue(row.content))
      ).artifacts)
        if (image.descriptor.id === artifactId)
          return {
            reference: image.reference,
            filename: image.descriptor.filename,
          }
    const value = parsedRecord(row.content ?? row.result)
    if (!value || value.ok !== true || value.type !== "aos.artifact") continue
    const artifact = isRecord(value.artifact) ? value.artifact : undefined
    const id = trimmedText(artifact?.id)
    const path = trimmedText(artifact?.path)
    const filename = trimmedText(artifact?.filename)
    if (
      id !== artifactId ||
      !path ||
      !filename ||
      path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(path) ||
      path.split(/[\\/]/u).includes("..")
    )
      continue
    // Hermes resolves a relative path only against the Session's persisted cwd,
    // which is often empty; the receipt's validated root makes the read absolute.
    const workdir = trimmedText(artifact?.workdir)
    const reference =
      workdir && workdir.startsWith("/") && !workdir.split("/").includes("..")
        ? `${workdir.replace(/\/+$/u, "")}/${path}`
        : path
    return { reference, filename }
  }
  return undefined
}
