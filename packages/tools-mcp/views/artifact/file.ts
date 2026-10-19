import { z } from "zod"

import {
  FILE_READ_LIMIT,
  FileReadRefusalSchema,
} from "../../../../shared/presentation/file-reads"
import { syntaxLanguageFromFilename } from "../../../../shared/syntax-language"
import type { ViewApp } from "../view"
import { codeLanguage } from "./code"

/** How a text file lays out: as prose, a table, or highlighted source. */
export type TextFormat =
  | { format: "plain" | "markdown" | "csv" | "json" }
  | { format: "code"; language: string }

/** Audio or video, played whole from a `data:` address. */
export type MediaPreview = { kind: "audio" | "video"; url: string }

export type FilePreview =
  | { kind: "pdf"; blob: Blob }
  | { kind: "image"; url: string }
  | { kind: "html"; text: string }
  | ({ kind: "text"; text: string } & TextFormat)
  | MediaPreview
  | { kind: "none" }

/**
 * A file still loading, refused for a reason its read names, unread because
 * the page cannot read it here, or ready to show.
 */
export type FileState =
  | {
      status: "loading" | "unreachable" | "denied" | "tooLarge" | "unavailable"
    }
  | { status: "ready"; preview: FilePreview }

/** What a file is shown as: a preview read from it. */
export type FileKind = Exclude<FilePreview["kind"], "none">

export type PreviewLimits = Record<FileKind, number>

const MIB = 1024 * 1024

/**
 * The largest file of each kind, in bytes, the view previews; a larger one is
 * only offered. Every read stops at `FILE_READ_LIMIT`, and the view lays text
 * out itself, so text gets the least.
 */
export const PREVIEW_LIMITS: PreviewLimits = {
  pdf: FILE_READ_LIMIT,
  image: FILE_READ_LIMIT,
  audio: FILE_READ_LIMIT,
  video: FILE_READ_LIMIT,
  html: 25 * MIB,
  text: 2 * MIB,
}

const TEXT_EXTENSIONS = "log tsv txt"

/**
 * The type a file's extension names, for a file whose type was not declared;
 * source the view highlights is `text/x-<language>`, as its name names it.
 */
const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  htm: "text/html",
  html: "text/html",
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  markdown: "text/markdown",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
  ...Object.fromEntries(
    TEXT_EXTENSIONS.split(" ").map((extension) => [extension, "text/plain"])
  ),
}

const TEXT_TYPE =
  /^text\/|^application\/(?:json|xml|javascript|typescript|x-javascript|x-typescript|yaml|x-yaml|toml)$|\+(?:json|xml)$/u

/** A media type without its parameters, such as `; charset=utf-8`. */
function mediaType(value: string | null | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined
}

function extensionType(filename: string) {
  const extension = /\.([^./]+)$/u.exec(filename)?.[1]?.toLowerCase()
  const type = extension === undefined ? undefined : EXTENSION_TYPES[extension]
  const language = codeLanguage(syntaxLanguageFromFilename(filename))
  return type ?? (language === undefined ? undefined : `text/x-${language}`)
}

export function kindOf(type: string | undefined): FileKind | undefined {
  if (type === "application/pdf") return "pdf"
  if (type === "text/html" || type === "application/xhtml+xml") return "html"
  if (type?.startsWith("image/")) return "image"
  if (type?.startsWith("audio/")) return "audio"
  if (type?.startsWith("video/")) return "video"
  if (type !== undefined && TEXT_TYPE.test(type)) return "text"
  return undefined
}

export function textFormat(type: string): TextFormat {
  if (type === "text/markdown") return { format: "markdown" }
  if (type === "text/csv") return { format: "csv" }
  if (type === "application/json") return { format: "json" }
  // A source type names its language, as `text/x-python` and
  // `application/typescript` do.
  const language = codeLanguage(type.split("/")[1]?.replace(/^x-/u, ""))
  return language ? { format: "code", language } : { format: "plain" }
}

/**
 * A text type the view shows only as plain text, other than `text/plain`
 * itself, such as the `text/vnd.trolltech.linguist` a system names `.ts` by.
 */
function vague(type: string) {
  return (
    type !== "text/plain" &&
    kindOf(type) === "text" &&
    textFormat(type).format === "plain"
  )
}

/**
 * The type a file is known by before any of it is read: the one the Agent
 * declared, then the file name's; a vague declared text type yields to the
 * file name's.
 */
export function knownType(file: {
  filename: string
  mimeType?: string | undefined
}) {
  const declared = mediaType(file.mimeType)
  return (
    (declared !== undefined && !vague(declared) ? declared : undefined) ??
    extensionType(file.filename) ??
    declared
  )
}

/** How many bytes base64 `text` decodes to. */
function decodedSize(text: string) {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0
  return (text.length / 4) * 3 - padding
}

function decode(text: string) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

function preview(kind: FileKind, type: string, blob: string): FilePreview {
  // The view's policy loads images and media only from `data:` addresses.
  if (kind === "image" || kind === "audio" || kind === "video")
    return { kind, url: `data:${type};base64,${blob}` }
  const bytes = decode(blob)
  if (kind === "pdf") return { kind, blob: new Blob([bytes], { type }) }
  const text = new TextDecoder().decode(bytes)
  if (kind === "html") return { kind, text }
  return { kind, text, ...textFormat(type) }
}

/** A read's JSON-RPC error that names why it failed. */
const RefusedReadSchema = z.object({
  data: z.object({ reason: FileReadRefusalSchema }),
})

/**
 * Why a read failed, by the `data.reason` its JSON-RPC error carries; a read
 * that names none the view knows, or that the page could not make at all, is
 * one the page cannot make here.
 */
function failure(error: unknown) {
  return RefusedReadSchema.safeParse(error).data?.data.reason ?? "unavailable"
}

const NO_PREVIEW: FileState = { status: "ready", preview: { kind: "none" } }

/**
 * Reads the file at `address` whole through the page, as the `aos-ui` server
 * reads it there (`resources/read`), and prepares its preview, up to its
 * kind's limit. The first type that is known decides how it shows: the one the
 * Agent declared, then the file name's, then the one it was read as; a vague
 * declared text type yields to the file name's. A file known to have no
 * preview is not read at all, and `signal` cancels the read.
 */
export async function loadFile(
  read: ViewApp["readServerResource"],
  address: string,
  file: { filename: string; mimeType?: string | undefined },
  limits: PreviewLimits,
  signal: AbortSignal
): Promise<FileState> {
  const known = knownType(file)
  if (known !== undefined && kindOf(known) === undefined) return NO_PREVIEW
  try {
    const [content] = (await read({ uri: address }, { signal })).contents
    if (!content || !("blob" in content)) return { status: "unavailable" }
    const type = known ?? mediaType(content.mimeType)
    const kind = kindOf(type)
    if (type === undefined || kind === undefined) return NO_PREVIEW
    if (decodedSize(content.blob) > limits[kind]) return { status: "tooLarge" }
    return { status: "ready", preview: preview(kind, type, content.blob) }
  } catch (error) {
    return { status: failure(error) }
  }
}
